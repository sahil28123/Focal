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
  confidence: number;   // 0–1
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
  recentDiff?: string;     // git diff --name-only or --stat output
  errorMessage?: string;
}

export interface PinnedNode {
  filePath: string;
  symbol?: string;
  line?: number;
  source: 'stack_trace' | 'test_failure' | 'git_diff' | 'manual';
  errorSignalBoost: number;  // 0–1; overrides computed score
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

  // Override auto-detected intent
  intent?: TaskIntentType;

  // Runtime signals — stack traces, test failures, git diffs
  runtimeSignals?: RuntimeSignals;

  // Optional LLM summarizer — bring your own, Focal has no hard dep
  summarize?: (content: string, query: string, filePath: string) => Promise<string>;

  // Optional embedding function — bring your own model
  embed?: (texts: string[]) => Promise<number[][]>;
}
