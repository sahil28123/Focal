# Focal — Context Engine for AI Coding Agents
### Build Plan for Claude

---

## What you are building

**Focal** is an open-source TypeScript library and CLI that builds optimized context packages for LLM-powered coding agents. Given a repo path and a task description, Focal parses the codebase into a code graph, scores every file and function by relevance to the task, and returns a structured context object — ready to send to Claude, GPT-4, or any LLM API — that fits within a token budget.

**One-line pitch:** "Give your coding agent only the code it needs."

---

## Project structure to create

```
focal/
├── packages/
│   ├── core/                  # Main library (@focal/core)
│   │   ├── src/
│   │   │   ├── graph/         # Code graph engine
│   │   │   ├── memory/        # Change memory
│   │   │   ├── retrieval/     # Retrieval engine
│   │   │   ├── ranking/       # Scoring engine
│   │   │   ├── compiler/      # Context compiler + token budget
│   │   │   ├── types.ts       # All shared types/interfaces
│   │   │   └── index.ts       # Public API
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/                   # CLI tool (@focal/cli)
│       ├── src/
│       │   └── index.ts
│       └── package.json
├── examples/
│   └── basic-usage.ts
├── package.json               # Workspace root
├── tsconfig.json
└── README.md
```

---

## Phase 1 — Core types and interfaces

**File: `packages/core/src/types.ts`**

Define all shared types before writing any logic. Every module depends on these.

```typescript
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
    relevance: number;       // 0–1: semantic + keyword match to query
    dependency: number;      // 0–1: normalized graph depth score
    recency: number;         // 0–1: decay from lastModified
    errorSignal: number;     // 0–1: linkage to errors/failures
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
  repoPath: string;
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
}
```

---

## Phase 2 — Code graph engine

**File: `packages/core/src/graph/parser.ts`**

Use **tree-sitter** to parse files into `FileNode` objects. Tree-sitter has Node.js bindings and supports TypeScript, JavaScript, Python, Go, and more.

Install dependencies:
```bash
npm install tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python
```

Implement this interface:

```typescript
export interface Parser {
  parseFile(filePath: string): Promise<FileNode>;
  parseRepo(repoPath: string, options?: { exclude?: string[] }): Promise<FileNode[]>;
}
```

Implementation notes:
- Walk the repo directory recursively, skip `node_modules`, `.git`, `dist`, `build`
- Detect language from file extension: `.ts`/`.tsx` → TypeScript, `.js`/`.jsx` → JavaScript, `.py` → Python
- For each file, use tree-sitter to extract: function declarations, class declarations, import statements, export declarations
- Function calls: walk the AST looking for `call_expression` nodes — collect the callee identifiers
- Return `lastModified` from `fs.stat`

**File: `packages/core/src/graph/builder.ts`**

```typescript
export interface GraphBuilder {
  build(files: FileNode[]): CodeGraph;
}
```

Implementation notes:
- Build `importGraph` by resolving import paths relative to each file
- Build `callGraph` by linking `FunctionNode.calls` to their resolved `functionId` (format: `filePath::functionName`)
- Store the result as a `CodeGraph`

**File: `packages/core/src/graph/index.ts`** — re-export `Parser` and `GraphBuilder`

---

## Phase 3 — Change memory

**File: `packages/core/src/memory/store.ts`**

A simple persistent store for `ChangeRecord` objects. Use **lowdb** (lightweight JSON database) so there are no infrastructure dependencies.

```bash
npm install lowdb
```

```typescript
export interface MemoryStore {
  init(storagePath: string): Promise<void>;
  add(record: Omit<ChangeRecord, 'id' | 'timestamp'>): Promise<ChangeRecord>;
  getRecent(limit?: number): Promise<ChangeRecord[]>;
  getForFiles(filePaths: string[]): Promise<ChangeRecord[]>;
  markOutcome(id: string, outcome: 'success' | 'failure'): Promise<void>;
  clear(): Promise<void>;
}
```

Storage path defaults to `<repoPath>/.focal/memory.json`. Create the `.focal/` directory if it does not exist. Add `.focal/` to `.gitignore` automatically on first init.

---

## Phase 4 — Retrieval engine

**File: `packages/core/src/retrieval/engine.ts`**

Retrieve the top candidates for a query. This is NOT pure embedding similarity — it combines three signals:

```typescript
export interface RetrievalEngine {
  retrieve(
    query: string,
    graph: CodeGraph,
    memory: MemoryStore,
    options?: { topK?: number }
  ): Promise<ContextCandidate[]>;
}
```

**Retrieval strategy (implement all three, combine results):**

1. **Keyword match** — tokenize the query (split on spaces, camelCase, snake_case). Score each file/function by how many query tokens appear in its path, name, or (if feasible) content. Normalize to 0–1.

2. **Import graph traversal** — identify "seed" files from keyword match. Then walk the import graph outward 1–2 hops. Files directly imported by seeds score 0.7, files imported by those score 0.4.

3. **Memory linkage** — call `memory.getForFiles(candidateFiles)`. Any file that appears in a `ChangeRecord` related to similar past queries (simple string overlap on `description`) gets an error signal boost.

Merge results, deduplicate, return as `ContextCandidate[]` with the `scores` object populated. Set `finalScore` to 0 for now — that is computed in the ranking phase.

---

## Phase 5 — Ranking engine

**File: `packages/core/src/ranking/scorer.ts`**

Takes `ContextCandidate[]` and computes `finalScore` for each.

```typescript
export interface Scorer {
  score(
    candidates: ContextCandidate[],
    weights: Required<FocalConfig['weights']>
  ): ContextCandidate[];
}
```

**Scoring formula:**

```
finalScore = (w_relevance   * scores.relevance)
           + (w_dependency  * scores.dependency)
           + (w_recency     * scores.recency)
           + (w_errorSignal * scores.errorSignal)
```

Default weights: `{ relevance: 0.4, dependency: 0.25, recency: 0.15, errorSignal: 0.2 }`

**Recency score formula:**

```typescript
const AGE_HALF_LIFE_DAYS = 14;
const ageInDays = (Date.now() - file.lastModified) / (1000 * 60 * 60 * 24);
scores.recency = Math.exp(-Math.LN2 * ageInDays / AGE_HALF_LIFE_DAYS);
```

Files modified today score 1.0, files modified 14 days ago score 0.5, 28 days ago score 0.25.

**Dependency score formula:**

```typescript
// hopDistance: minimum graph hops from any seed file (1 = direct import)
scores.dependency = Math.max(0, 1 - (hopDistance * 0.3));
// direct dep = 0.7, 2 hops = 0.4, 3 hops = 0.1, 4+ hops = 0
```

Return candidates sorted descending by `finalScore`.

---

## Phase 6 — Context compiler

**File: `packages/core/src/compiler/compiler.ts`**

Takes ranked `ContextCandidate[]` and builds the final `FocalContext` within a token budget.

```typescript
export interface ContextCompiler {
  compile(
    candidates: ContextCandidate[],
    config: Required<Pick<FocalConfig, 'query' | 'tokenBudget' | 'repoPath'>>
  ): Promise<FocalContext>;
}
```

**Token budget algorithm:**

Use a simple heuristic: 1 token ≈ 4 characters. Implement `estimateTokens(text: string): number`.

For each candidate in ranked order:
1. Try to include the full file content. If it fits in remaining budget → `resolution: 'full'`
2. If the full file is too large but 40%+ of budget remains → include function signatures only (first line of each function + class declarations). This is `resolution: 'signature-only'`
3. If budget is nearly exhausted → skip this file entirely
4. Stop when budget is consumed. Set `truncated: true`

**Multi-resolution content:**

```typescript
function extractSignatures(fileContent: string, fileNode: FileNode): string {
  // Return just: imports + function signatures (no bodies) + class declarations
  // Format: "{imports}\n\n// ... {n} functions — signatures only ...\n{signatures}"
}
```

Build the `summary` string: `"Included {n} files ({tokensUsed} tokens). Top files: {top3FileNames}. Focused on: {query}."`

---

## Phase 7 — Public API

**File: `packages/core/src/index.ts`**

```typescript
import { Parser } from './graph/parser';
import { GraphBuilder } from './graph/builder';
import { MemoryStore } from './memory/store';
import { RetrievalEngine } from './retrieval/engine';
import { Scorer } from './ranking/scorer';
import { ContextCompiler } from './compiler/compiler';

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

    // 5. Score and rank
    const scorer = new Scorer();
    const ranked = scorer.score(candidates, cfg.weights);

    // 6. Compile context
    const compiler = new ContextCompiler();
    const context = await compiler.compile(ranked, cfg);

    return { ...context, buildTimeMs: Date.now() - start };
  }
}

function applyDefaults(config: FocalConfig): Required<FocalConfig> {
  return {
    tokenBudget: 8000,
    weights: { relevance: 0.4, dependency: 0.25, recency: 0.15, errorSignal: 0.2 },
    exclude: ['node_modules', '.git', 'dist', 'build', '*.test.*', '*.spec.*'],
    memoryPath: `${config.repoPath}/.focal`,
    ...config,
    weights: { ...{ relevance: 0.4, dependency: 0.25, recency: 0.15, errorSignal: 0.2 }, ...config.weights },
  };
}

export type { FocalConfig, FocalContext, IncludedFile, ChangeRecord, CodeGraph };
```

---

## Phase 8 — CLI

**File: `packages/cli/src/index.ts`**

Use **commander** for CLI argument parsing. Install: `npm install commander`

```bash
focal build --repo ./my-project --query "Fix login bug" --budget 6000
focal build --repo ./my-project --query "Fix login bug" --budget 6000 --output context.json
focal memory add --repo ./my-project --description "Fixed token validation" --files "src/auth.ts"
focal memory list --repo ./my-project
```

**`focal build` output (stdout):**
```
Focal — context built in 340ms
─────────────────────────────────────
Query:   Fix login bug
Budget:  6000 tokens
Used:    4821 tokens (80%)
Files:   3 included, 1 signature-only, 14 skipped

  ● src/auth/login.ts         (score: 0.91)  full
  ● src/auth/token.ts         (score: 0.78)  full
  ● src/db/users.ts           (score: 0.61)  full
  ◌ src/middleware/session.ts (score: 0.44)  signature-only

Context written to: context.json
```

If `--output` is specified, write the `FocalContext` JSON to that file. Otherwise print the JSON to stdout.

---

## Phase 9 — Package configuration

**`package.json` (workspace root):**
```json
{
  "name": "focal",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc -b packages/core packages/cli",
    "dev": "tsc -b --watch",
    "test": "jest"
  }
}
```

**`packages/core/package.json`:**
```json
{
  "name": "@focal/core",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-javascript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "lowdb": "^7.0.1"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0"
  }
}
```

**`packages/cli/package.json`:**
```json
{
  "name": "@focal/cli",
  "version": "0.1.0",
  "bin": { "focal": "dist/index.js" },
  "dependencies": {
    "@focal/core": "*",
    "commander": "^12.0.0"
  }
}
```

**`tsconfig.json` (root):**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

---

## Phase 10 — Example and README

**`examples/basic-usage.ts`:**
```typescript
import { Focal } from '@focal/core';

const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  tokenBudget: 6000,
});

console.log(`Included ${context.files.length} files in ${context.tokensUsed} tokens`);
console.log(context.summary);

// Pass to Claude
const response = await anthropic.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 2048,
  messages: [{
    role: 'user',
    content: `${context.files.map(f => `// ${f.path}\n${f.content}`).join('\n\n')}\n\nTask: ${context.query}`
  }]
});
```

**`README.md`** — write a concise readme with: one-line description, install instructions (`npm install @focal/core`), the basic-usage example, and a section listing the scoring signals with their default weights.

---

## Build order

Build phases strictly in this order. Each phase depends on the previous.

1. Scaffold workspace (`package.json`, `tsconfig.json`, directory structure)
2. `types.ts` — all types first, no logic
3. `graph/parser.ts` + `graph/builder.ts`
4. `memory/store.ts`
5. `retrieval/engine.ts`
6. `ranking/scorer.ts`
7. `compiler/compiler.ts`
8. `core/index.ts` (public API)
9. `cli/index.ts`
10. `examples/basic-usage.ts` + `README.md`

After each phase, run `tsc --noEmit` to confirm the types compile cleanly before proceeding.

---

## Key decisions to preserve

- **No vector database dependency.** Retrieval uses keyword matching + graph traversal. Embedding-based similarity is optional and should be addable later without breaking the core API.
- **No external services.** Everything runs locally. The memory store is a local JSON file. This is essential for developer adoption — zero infra to set up.
- **Token estimation is approximate.** Use the 4-chars-per-token heuristic. Do not add a full tokenizer dependency in V1.
- **Weights are configurable but have sensible defaults.** Never hardcode the `0.4/0.25/0.15/0.2` split inside logic — always read from `config.weights` so users can tune without forking.
- **`FocalContext` is serializable JSON.** No class instances or functions in the output. This makes it easy to cache, log, and pass to any LLM API.

---

## What is explicitly out of scope for V1

- Real-time file watching / incremental graph updates
- Multi-repo support
- Authentication or secrets management
- VS Code / Cursor plugin (design the API so it's easy to add later)
- LLM-generated summaries of files (add in V2 once token budget logic is stable)
- Embedding-based semantic search (add in V2 as an optional retrieval strategy)