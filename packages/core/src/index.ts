import { Parser } from './graph/parser';
import { GraphBuilder } from './graph/builder';
import { MemoryStore } from './memory/store';
import { RetrievalEngine } from './retrieval/engine';
import { Scorer } from './ranking/scorer';
import { ContextCompiler } from './compiler/compiler';
import { FocalConfig, FocalContext } from './types';

export class Focal {
  static async build(config: FocalConfig): Promise<FocalContext> {
    const start = Date.now();
    const cfg = applyDefaults(config);

    // 1. Parse the repo
    const parser = new Parser();
    const files = await parser.parseRepo(cfg.repoPath, { exclude: cfg.exclude });

    // 2. Build code graph
    const builder = new GraphBuilder();
    const graph = builder.build(files);

    // 3. Init memory
    const memory = new MemoryStore();
    await memory.init(cfg.memoryPath);

    // 4. Retrieve candidates
    const retrieval = new RetrievalEngine();
    const candidates = await retrieval.retrieve(cfg.query, graph, memory);

    // 5. Score and rank (pass file nodes for recency calculation)
    const scorer = new Scorer();
    const ranked = scorer.score(candidates, cfg.weights, graph.files);

    // 6. Compile context
    const compiler = new ContextCompiler();
    const context = await compiler.compile(ranked, {
      ...cfg,
      fileNodes: graph.files,
    });

    return { ...context, buildTimeMs: Date.now() - start };
  }
}

function applyDefaults(config: FocalConfig): Required<FocalConfig> & {
  weights: Required<NonNullable<FocalConfig['weights']>>;
} {
  const defaultWeights = { relevance: 0.4, dependency: 0.25, recency: 0.15, errorSignal: 0.2 };
  return {
    tokenBudget: 8000,
    exclude: ['node_modules', '.git', 'dist', 'build', '*.test.*', '*.spec.*'],
    memoryPath: `${config.repoPath}/.focal`,
    ...config,
    weights: { ...defaultWeights, ...config.weights },
  };
}

export type { FocalConfig, FocalContext, IncludedFile, ChangeRecord, CodeGraph } from './types';
export { MemoryStore } from './memory/store';
