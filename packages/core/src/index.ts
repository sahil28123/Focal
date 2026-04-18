import { Parser } from './graph/parser';
import { GraphBuilder } from './graph/builder';
import { GraphCache } from './graph/cache';
import { RepoWatcher } from './graph/watcher';
import { MemoryStore } from './memory/store';
import { MemoryAutoCollector } from './memory/auto-collector';
import { IntentClassifier } from './intent/classifier';
import { RuntimeSignalIngester } from './signals/index';
import { RetrievalEngine } from './retrieval/engine';
import { Scorer } from './ranking/scorer';
import { ContextCompiler } from './compiler/compiler';
import { FocalConfig, FocalContext } from './types';

// Shared parse cache — survives across build() calls, enables incremental updates
const sharedCache = new GraphCache();

export class Focal {
  /**
   * Build an optimized context package for the given query.
   *
   * New in V2:
   *   - Intent auto-detection (or override with config.intent)
   *   - Runtime signals: stack traces, test failures, git diffs
   *   - Function-level BM25 retrieval
   *   - Intent-aware scoring profiles
   *   - Knapsack VPT allocation (replaces greedy)
   *   - Multi-repo (repoPath: string | string[])
   */
  static async build(config: FocalConfig): Promise<FocalContext> {
    const start = Date.now();
    const cfg = applyDefaults(config);
    const repoPaths = Array.isArray(cfg.repoPath) ? cfg.repoPath : [cfg.repoPath];

    // 1. Classify intent
    const classifier = new IntentClassifier();
    const intent = cfg.intent
      ? classifier.fromType(cfg.intent, cfg.query, cfg.runtimeSignals)
      : classifier.classify(cfg.query, cfg.runtimeSignals);

    // 2. Ingest runtime signals (stack traces, test failures, git diffs)
    const ingester = new RuntimeSignalIngester();
    const { pinnedNodes, boostMap } = cfg.runtimeSignals
      ? ingester.ingest(cfg.runtimeSignals, repoPaths)
      : { pinnedNodes: [], boostMap: new Map() };

    // 3. Parse repos (incremental — only changed files re-parsed via sharedCache)
    const parser = new Parser(sharedCache);
    const allFiles = (
      await Promise.all(repoPaths.map((rp) => parser.parseRepo(rp, { exclude: cfg.exclude })))
    ).flat();

    // 4. Build unified code graph
    const builder = new GraphBuilder();
    const graph = builder.build(allFiles);

    // 5. Init memory store
    const memory = new MemoryStore();
    await memory.init(cfg.memoryPath);

    // 6. Retrieve — function-level BM25 + call graph + runtime boosts + memory
    const retrieval = new RetrievalEngine();
    const { candidates, seedFiles } = await retrieval.retrieve(
      cfg.query,
      graph,
      memory,
      { intent, pinnedNodes, boostMap, embed: cfg.embed }
    );

    // 7. Score with intent-weighted profiles
    const scorer = new Scorer();
    const ranked = scorer.score(candidates, intent, cfg.weights, graph.files);

    // 8. Compile with knapsack VPT allocation
    const compiler = new ContextCompiler();
    const context = await compiler.compile(ranked, {
      query: cfg.query,
      tokenBudget: cfg.tokenBudget,
      repoPath: cfg.repoPath,
      intent,
      fileNodes: graph.files,
      pinnedNodes,
      summarize: cfg.summarize,
      totalCandidates: candidates.length,
    });

    // Patch in seed files from retrieval
    context.graph.seedFiles = seedFiles;

    // 9. Auto-record this build in memory (async, non-blocking)
    const collector = new MemoryAutoCollector(memory);
    collector.recordBuild(context).catch(() => { /* non-fatal */ });

    return { ...context, buildTimeMs: Date.now() - start };
  }

  /**
   * Watch repos and rebuild context on every file change.
   * Uses Node's built-in fs.watch — zero external dependencies.
   *
   * @returns A stop() function that tears down all watchers.
   *
   * @example
   * const stop = Focal.watch(config, (ctx) => sendToAgent(ctx));
   * // later: stop();
   */
  static watch(
    config: FocalConfig,
    onUpdate: (context: FocalContext) => void,
    onError?: (err: Error) => void
  ): () => void {
    const repoPaths = Array.isArray(config.repoPath) ? config.repoPath : [config.repoPath];

    // Initial build
    Focal.build(config).then(onUpdate).catch((e) => onError?.(e as Error));

    let pending = false;
    const watcher = new RepoWatcher();

    watcher.on('change', (event: { filePath: string }) => {
      sharedCache.invalidate(event.filePath);
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        Focal.build(config).then(onUpdate).catch((e) => onError?.(e as Error));
      }, 300);
    });

    watcher.watch(repoPaths);
    return () => watcher.stop();
  }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

type ResolvedWeights = Required<NonNullable<FocalConfig['weights']>>;
type ResolvedConfig = FocalConfig & {
  tokenBudget: number;
  exclude: string[];
  memoryPath: string;
  weights: ResolvedWeights;
};

function applyDefaults(config: FocalConfig): ResolvedConfig {
  const firstRepo = Array.isArray(config.repoPath) ? config.repoPath[0] : config.repoPath;
  const defaultWeights: ResolvedWeights = {
    relevance: 0.4, dependency: 0.25, recency: 0.15, errorSignal: 0.2,
  };
  return {
    tokenBudget: 8000,
    exclude: ['node_modules', '.git', 'dist', 'build', '*.test.*', '*.spec.*'],
    memoryPath: `${firstRepo}/.focal`,
    ...config,
    weights: { ...defaultWeights, ...config.weights },
  };
}

// ─── Public exports ───────────────────────────────────────────────────────────

export type {
  FocalConfig, FocalContext, IncludedFile, ChangeRecord, CodeGraph,
  TaskIntent, TaskIntentType, RuntimeSignals, PinnedNode,
} from './types';

export { MemoryStore }         from './memory/store';
export { MemoryAutoCollector } from './memory/auto-collector';
export { GraphCache }          from './graph/cache';
export { RepoWatcher }         from './graph/watcher';
export { FocalFormatter }      from './formatter/index';
export { IntentClassifier }    from './intent/classifier';
export { RuntimeSignalIngester, parseStackTrace, parseTestOutput, parseGitDiff } from './signals/index';
