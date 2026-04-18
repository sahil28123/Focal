// ─── Parse nodes ──────────────────────────────────────────────────────────────

export interface FileNode {
  path: string;
  language: string;
  functions: FunctionNode[];
  classes: ClassNode[];
  imports: string[];
  exports: string[];
  lastModified: number;
  size: number;
}

export interface FunctionNode {
  name: string;
  startLine: number;
  endLine: number;
  calls: string[];
  params: string[];
  isExported: boolean;
}

export interface ClassNode {
  name: string;
  methods: string[];
  extends?: string;
  isExported: boolean;
}

// ─── Code graph ───────────────────────────────────────────────────────────────

export interface CodeGraph {
  files: Map<string, FileNode>;
  callGraph: Map<string, string[]>;    // functionId -> [called functionIds]
  importGraph: Map<string, string[]>;  // filePath -> [imported filePaths]
  builtAt: number;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export interface ChangeRecord {
  id: string;
  timestamp: number;
  type: 'change' | 'fix' | 'failed_attempt';
  files: string[];
  description: string;
  diff?: string;
  outcome?: 'success' | 'failure' | 'unknown';
}

// ─── Intent ───────────────────────────────────────────────────────────────────

export type TaskIntentType = 'bug_fix' | 'feature' | 'refactor' | 'understand';

export interface TaskIntent {
  type: TaskIntentType;
  confidence: number;
  signals: {
    errorPatterns: string[];
    stackFiles: string[];
    domain: string[];
    targetSymbols: string[];
  };
}

// ─── Runtime signals ──────────────────────────────────────────────────────────

export interface RuntimeSignals {
  stackTrace?: string;
  testOutput?: string;
  recentDiff?: string;
  errorMessage?: string;
}

export interface PinnedNode {
  filePath: string;
  symbol?: string;
  line?: number;
  source: 'stack_trace' | 'test_failure' | 'git_diff' | 'manual';
  errorSignalBoost: number;
}

// ─── Execution path ───────────────────────────────────────────────────────────

export interface PathNode {
  filePath: string;
  functionName?: string;
  line?: number;
  /** true = hop verified by call graph; false = inferred from stack trace order */
  verified: boolean;
  isErrorSite: boolean;
  isEntryPoint: boolean;
}

export interface ExecutionPath {
  nodes: PathNode[];        // ordered entry → error
  errorSite: PathNode;
  entryPoint: PathNode;
  /** fraction of consecutive hops that were verified via call graph (0–1) */
  confidence: number;
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export interface ContextCandidate {
  type: 'file' | 'function' | 'snippet';
  path: string;
  functionName?: string;
  startLine?: number;
  endLine?: number;
  scores: {
    relevance: number;
    dependency: number;
    recency: number;
    errorSignal: number;
  };
  finalScore: number;
  tokenEstimate: number;
  pinned?: boolean;
}

// ─── Confidence ───────────────────────────────────────────────────────────────

export interface ContextConfidence {
  overall: number;          // 0–1
  verdict: 'high' | 'medium' | 'low';
  breakdown: {
    signalCoverage: number;    // fraction of pinned files actually included
    topCandidateScore: number; // finalScore of highest-ranked file
    memoryPatternHits: number; // 0–1: did memory patterns fire?
    budgetUtilization: number; // tokensUsed / tokenBudget
    diversityScore: number;    // 0–1: how many distinct directories represented
  };
  warnings: string[];       // e.g. "top candidate score is 0.2 — query may be too vague"
}

// ─── Output ───────────────────────────────────────────────────────────────────

export interface IncludedFile {
  path: string;
  repoRoot: string;
  content: string;
  reason: string;
  score: number;
  resolution: 'full' | 'summary' | 'signature-only' | 'snippet';
  snippet?: {
    startLine: number;
    endLine: number;
    symbol: string;
  };
  runtimeContext?: {
    appearsInStackTrace: boolean;
    failingTests: string[];
  };
  relatedSymbols: string[];
}

export interface FocalContext {
  query: string;
  intent: TaskIntent;
  tokenBudget: number;
  tokensUsed: number;
  files: IncludedFile[];
  summary: string;
  truncated: boolean;
  buildTimeMs: number;
  graph: {
    seedFiles: string[];
    reachableButExcluded: number;
  };
  pinnedFiles: string[];
  confidence: ContextConfidence;
  executionPath?: ExecutionPath;
}

// ─── Incremental delta ────────────────────────────────────────────────────────

export interface IncrementalDelta {
  /** Files newly added to context (not in previous) */
  added: IncludedFile[];
  /** Files in both contexts but whose content changed */
  changed: IncludedFile[];
  /** File paths that dropped out of context */
  removed: string[];
  /** File paths still in context, unchanged (content omitted to save tokens) */
  unchanged: string[];
  tokensUsed: number;
  tokensSaved: number;
  buildTimeMs: number;
  summary: string;
}

// ─── Enriched summarization ───────────────────────────────────────────────────

/** Richer context passed to summarizeEnriched() — explains relationships, not just content. */
export interface SummarizeInput {
  content: string;
  query: string;
  filePath: string;
  intent: TaskIntent;
  /** Role this file plays relative to the query */
  role: 'error_site' | 'caller' | 'dependency' | 'related';
  relationships: {
    /** Other files in this context that import this file */
    importedByInContext: string[];
    /** Files this file imports that are also in context */
    importsInContext: string[];
    /** Function names in other context files that call into this file */
    calledBySymbols: string[];
    /** External function names this file calls */
    callsSymbols: string[];
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface FocalConfig {
  repoPath: string | string[];
  query: string;
  tokenBudget?: number;
  weights?: {
    relevance?: number;
    dependency?: number;
    recency?: number;
    errorSignal?: number;
  };
  exclude?: string[];
  memoryPath?: string;

  /** Override auto-detected intent */
  intent?: TaskIntentType;

  /** Runtime signals — stack traces, test failures, git diffs */
  runtimeSignals?: RuntimeSignals;

  /** Simple summarizer: receives (content, query, filePath) */
  summarize?: (content: string, query: string, filePath: string) => Promise<string>;

  /**
   * Enriched summarizer: receives full relationship context.
   * Takes priority over `summarize` when both are provided.
   * Produces higher-quality summaries because it knows why the file matters.
   */
  summarizeEnriched?: (input: SummarizeInput) => Promise<string>;

  /** Optional embedding function — bring your own model */
  embed?: (texts: string[]) => Promise<number[][]>;
}
