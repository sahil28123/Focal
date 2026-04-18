// The result of parsing a single file
export interface FileNode {
  path: string;
  language: string;
  functions: FunctionNode[];
  classes: ClassNode[];
  imports: string[];           // resolved file paths this file imports
  exports: string[];           // exported symbol names
  lastModified: number;        // unix timestamp
  size: number;                // bytes
}

export interface FunctionNode {
  name: string;
  startLine: number;
  endLine: number;
  calls: string[];             // function names this function calls
  params: string[];
  isExported: boolean;
}

export interface ClassNode {
  name: string;
  methods: string[];
  extends?: string;
  isExported: boolean;
}

// The full code graph for a repo
export interface CodeGraph {
  files: Map<string, FileNode>;
  callGraph: Map<string, string[]>;     // functionId -> [called functionIds]
  importGraph: Map<string, string[]>;   // filePath -> [imported filePaths]
  builtAt: number;
}

// A stored record of a past change or attempt
export interface ChangeRecord {
  id: string;
  timestamp: number;
  type: 'change' | 'fix' | 'failed_attempt';
  files: string[];
  description: string;
  diff?: string;
  outcome?: 'success' | 'failure' | 'unknown';
}

// Scored context candidate (a file or function that might be included)
export interface ContextCandidate {
  type: 'file' | 'function';
  path: string;
  functionName?: string;
  scores: {
    relevance: number;       // 0-1: semantic + keyword match to query
    dependency: number;      // 0-1: normalized graph depth score
    recency: number;         // 0-1: decay from lastModified
    errorSignal: number;     // 0-1: linkage to errors/failures
  };
  finalScore: number;        // weighted sum
  tokenEstimate: number;
}

// The final structured output Focal returns
export interface FocalContext {
  query: string;
  tokenBudget: number;
  tokensUsed: number;
  files: IncludedFile[];
  summary: string;            // one-paragraph description of what was included and why
  truncated: boolean;         // true if budget was hit
  buildTimeMs: number;
}

export interface IncludedFile {
  path: string;
  content: string;            // actual file content (possibly compressed/summarized)
  reason: string;             // why this was included
  score: number;
  resolution: 'full' | 'summary' | 'signature-only';
}

// Config for a Focal.build() call
export interface FocalConfig {
  // V1: single repo. V2: array of repo paths for multi-repo support.
  repoPath: string | string[];
  query: string;
  tokenBudget?: number;       // default: 8000
  weights?: {
    relevance?: number;       // default: 0.4
    dependency?: number;      // default: 0.25
    recency?: number;         // default: 0.15
    errorSignal?: number;     // default: 0.2
  };
  exclude?: string[];         // glob patterns to exclude
  memoryPath?: string;        // path to store change memory (default: .focal/)

  // V2: optional LLM summary callback — bring your own LLM, no Focal dependency
  // Called when a file is too large for full inclusion but budget remains.
  // Return a concise summary string to use as the file's content.
  summarize?: (content: string, query: string, filePath: string) => Promise<string>;

  // V2: optional embedding function — bring your own model, no Focal dependency
  // Receives an array of texts, returns an array of embedding vectors.
  // When provided, used to boost relevance scores via cosine similarity.
  embed?: (texts: string[]) => Promise<number[][]>;
}
