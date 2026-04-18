import { Parser } from './graph/parser';
import { GraphBuilder } from './graph/builder';
import { GraphCache } from './graph/cache';
import { RepoWatcher } from './graph/watcher';
import { MemoryStore } from './memory/store';
import { MemoryAutoCollector } from './memory/auto-collector';
import { IntentClassifier } from './intent/classifier';
import { RuntimeSignalIngester } from './signals/index';
import { ExecutionPathBuilder } from './path/execution-path';
import { RetrievalEngine } from './retrieval/engine';
import { Scorer } from './ranking/scorer';
import { ContextCompiler } from './compiler/compiler';
import { ConfidenceEstimator } from './confidence/estimator';
import { FocalConfig, FocalContext } from './types';

const sharedCache = new GraphCache();

export class Focal {
  static async build(config: FocalConfig): Promise<FocalContext> {
    const start = Date.now();
    const cfg = applyDefaults(config);
    const repoPaths = Array.isArray(cfg.repoPath) ? cfg.repoPath : [cfg.repoPath];

    // 1. Classify intent
    const classifier = new IntentClassifier();
    const intent = cfg.intent
      ? classifier.fromType(cfg.intent, cfg.query, cfg.runtimeSignals)
      : classifier.classify(cfg.query, cfg.runtimeSignals);

    // 2. Ingest runtime signals
    const ingester = new RuntimeSignalIngester();
    const { pinnedNodes, boostMap } = cfg.runtimeSignals
      ? ingester.ingest(cfg.runtimeSignals, repoPaths)
      : { pinnedNodes: [], boostMap: new Map() };

    // 3. Parse repos (incremental cache)
    const parser = new Parser(sharedCache);
    const allFiles = (
      await Promise.all(repoPaths.map((rp) => parser.parseRepo(rp, { exclude: cfg.exclude })))
    ).flat();

    // 4. Build unified code graph
    const builder = new GraphBuilder();
    const graph = builder.build(allFiles);

    // 5. Reconstruct execution path from stack trace + call graph
    const pathBuilder = new ExecutionPathBuilder();
    const executionPath = pinnedNodes.length >= 2
      ? pathBuilder.build(pinnedNodes, graph) ?? undefined
      : undefined;

    // 6. Init memory
    const memory = new MemoryStore();
    await memory.init(cfg.memoryPath);

    // 7. Retrieve — function-level BM25 + failure patterns + breakage prediction + call graph
    const retrieval = new RetrievalEngine();
    const { candidates, seedFiles, patternHits } = await retrieval.retrieve(
      cfg.query, graph, memory,
      { intent, pinnedNodes, boostMap, embed: cfg.embed }
    );

    // 8. Score with intent profiles + diversity (MMR)
    const scorer = new Scorer();
    const ranked = scorer.score(candidates, intent, cfg.weights, graph.files);

    // 9. Compile with knapsack VPT allocation
    const compiler = new ContextCompiler();
    const context = await compiler.compile(ranked, {
      query: cfg.query,
      tokenBudget: cfg.tokenBudget,
      repoPath: cfg.repoPath,
      intent,
      fileNodes: graph.files,
      pinnedNodes,
      summarize: cfg.summarize,
      summarizeEnriched: cfg.summarizeEnriched,
      graph,
      totalCandidates: candidates.length,
    });

    // 10. Confidence estimation
    const estimator = new ConfidenceEstimator();
    const confidence = estimator.estimate(context, ranked, pinnedNodes, patternHits);

    // 11. Patch final fields
    context.graph.seedFiles = seedFiles;
    context.confidence = confidence;
    context.executionPath = executionPath;

    // 12. Auto-record build (async, non-blocking)
    const collector = new MemoryAutoCollector(memory);
    collector.recordBuild(context).catch(() => { /* non-fatal */ });

    return { ...context, buildTimeMs: Date.now() - start };
  }

  /**
   * Watch repos and rebuild on every file change.
   * Uses Node's built-in fs.watch — zero external dependencies.
   */
  static watch(
    config: FocalConfig,
    onUpdate: (context: FocalContext) => void,
    onError?: (err: Error) => void
  ): () => void {
    const repoPaths = Array.isArray(config.repoPath) ? config.repoPath : [config.repoPath];
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
  FocalConfig, FocalContext, IncludedFile, ChangeRecord, CodeGraph, IncrementalDelta,
  TaskIntent, TaskIntentType, RuntimeSignals, PinnedNode, ExecutionPath, PathNode,
  ContextConfidence, SummarizeInput,
} from './types';

export { MemoryStore }            from './memory/store';
export { MemoryAutoCollector }    from './memory/auto-collector';
export { FailurePatternIndex }    from './memory/pattern-index';
export { GraphCache }             from './graph/cache';
export { RepoWatcher }            from './graph/watcher';
export { FocalFormatter }         from './formatter/index';
export { IntentClassifier }       from './intent/classifier';
export { ExecutionPathBuilder }   from './path/execution-path';
export { BreakagePredictor }      from './prediction/breakage';
export { DiversityRanker }        from './ranking/diversity';
export { ConfidenceEstimator }    from './confidence/estimator';
export { FocalSession }           from './session/index';
export { buildIncremental }       from './incremental/index';
export { RuntimeSignalIngester, parseStackTrace, parseTestOutput, parseGitDiff } from './signals/index';
