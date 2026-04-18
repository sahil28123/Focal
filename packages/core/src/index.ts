import { Parser } from './graph/parser';
import { GraphBuilder } from './graph/builder';
import { GraphCache } from './graph/cache';
import { RepoWatcher } from './graph/watcher';
import { MemoryStore } from './memory/store';
import { RetrievalEngine } from './retrieval/engine';
import { Scorer } from './ranking/scorer';
import { ContextCompiler } from './compiler/compiler';
import { FocalConfig, FocalContext } from './types';

// Module-level shared cache — survives across build() calls in the same process.
// Enables incremental re-parsing: only changed files are re-parsed.
const sharedCache = new GraphCache();

export class Focal {
  /**
   * Build an optimized context package for the given query.
   * Supports single or multiple repos (V2: repoPath accepts string | string[]).
   */
  static async build(config: FocalConfig): Promise<FocalContext> {
    const start = Date.now();
    const cfg = applyDefaults(config);
    const repoPaths = Array.isArray(cfg.repoPath) ? cfg.repoPath : [cfg.repoPath];

    // 1. Parse all repos, using the shared cache for incremental updates
    const parser = new Parser(sharedCache);
    const allFiles = (
      await Promise.all(
        repoPaths.map((rp) => parser.parseRepo(rp, { exclude: cfg.exclude }))
      )
    ).flat();

    // 2. Build unified code graph across all repos
    const builder = new GraphBuilder();
    const graph = builder.build(allFiles);

    // 3. Init memory (anchored to first repo path)
    const memory = new MemoryStore();
    await memory.init(cfg.memoryPath);

    // 4. Retrieve candidates (TF-IDF + optional embeddings)
    const retrieval = new RetrievalEngine();
    const candidates = await retrieval.retrieve(cfg.query, graph, memory, {
      embed: cfg.embed,
    });

    // 5. Score and rank
    const scorer = new Scorer();
    const ranked = scorer.score(candidates, cfg.weights, graph.files);

    // 6. Compile context (with optional LLM summarize callback)
    const compiler = new ContextCompiler();
    const context = await compiler.compile(ranked, {
      ...cfg,
      fileNodes: graph.files,
      summarize: cfg.summarize,
    });

    return { ...context, buildTimeMs: Date.now() - start };
  }

  /**
   * Watch repos for changes and rebuild context incrementally on every change.
   * Uses Node's built-in fs.watch — zero external dependencies.
   *
   * Returns a stop() function to tear down the watcher.
   *
   * @example
   * const stop = Focal.watch(config, (ctx) => {
   *   console.log('Context updated:', ctx.summary);
   * });
   * // later...
   * stop();
   */
  static watch(
    config: FocalConfig,
    onUpdate: (context: FocalContext) => void,
    onError?: (err: Error) => void
  ): () => void {
    const cfg = applyDefaults(config);
    const repoPaths = Array.isArray(cfg.repoPath) ? cfg.repoPath : [cfg.repoPath];

    // Build initial context immediately
    Focal.build(config).then(onUpdate).catch((err) => onError?.(err));

    let rebuildQueued = false;

    const watcher = new RepoWatcher();

    watcher.on('change', (event: { filePath: string }) => {
      // Invalidate the cache entry for the changed file so it gets re-parsed
      sharedCache.invalidate(event.filePath);

      // Debounce rapid cascading changes into a single rebuild
      if (rebuildQueued) return;
      rebuildQueued = true;

      setTimeout(() => {
        rebuildQueued = false;
        Focal.build(config).then(onUpdate).catch((err) => onError?.(err));
      }, 300);
    });

    watcher.watch(repoPaths);

    return () => watcher.stop();
  }
}

type ResolvedWeights = Required<NonNullable<FocalConfig['weights']>>;
type ResolvedConfig = Omit<FocalConfig, 'repoPath' | 'tokenBudget' | 'exclude' | 'memoryPath' | 'weights'> & {
  repoPath: string | string[];
  tokenBudget: number;
  exclude: string[];
  memoryPath: string;
  weights: ResolvedWeights;
};

function applyDefaults(config: FocalConfig): ResolvedConfig {
  const defaultWeights: ResolvedWeights = {
    relevance: 0.4,
    dependency: 0.25,
    recency: 0.15,
    errorSignal: 0.2,
  };
  const firstRepo = Array.isArray(config.repoPath) ? config.repoPath[0] : config.repoPath;
  return {
    tokenBudget: 8000,
    exclude: ['node_modules', '.git', 'dist', 'build', '*.test.*', '*.spec.*'],
    memoryPath: `${firstRepo}/.focal`,
    ...config,
    weights: { ...defaultWeights, ...config.weights },
  };
}

export type { FocalConfig, FocalContext, IncludedFile, ChangeRecord, CodeGraph } from './types';
export { MemoryStore } from './memory/store';
export { GraphCache } from './graph/cache';
export { RepoWatcher } from './graph/watcher';
