# Focal

**Give your coding agent only the code it needs.**

Focal is an open-source TypeScript library and CLI that builds optimized context packages for LLM-powered coding agents. Given a repo path and a task description, Focal parses the codebase into a code graph, scores every file and function by relevance to the task, and returns a structured context object — ready to send to Claude, GPT-4, or any LLM API — that fits within a token budget.

## Install

```bash
npm install @focal/core
```

## Basic usage

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

## CLI

```bash
# Build context and print to stdout
focal build --repo ./my-project --query "Fix login bug" --budget 6000

# Write context JSON to a file
focal build --repo ./my-project --query "Fix login bug" --budget 6000 --output context.json

# Record a change in memory
focal memory add --repo ./my-project --description "Fixed token validation" --files "src/auth.ts"

# List recent memory records
focal memory list --repo ./my-project
```

## Scoring signals

Focal ranks files using four signals combined into a weighted score:

| Signal | Default weight | Description |
|---|---|---|
| `relevance` | 0.40 | Keyword match between query and file paths, function names, content |
| `errorSignal` | 0.20 | Linkage to past failed attempts in change memory |
| `dependency` | 0.25 | Graph distance from seed files via import traversal |
| `recency` | 0.15 | Exponential decay from last modified time (half-life: 14 days) |

Customize weights via the `weights` config option:

```typescript
await Focal.build({
  repoPath: './my-project',
  query: 'Fix login bug',
  weights: {
    relevance: 0.5,
    dependency: 0.3,
    recency: 0.1,
    errorSignal: 0.1,
  },
});
```

## How it works

1. **Parse** — walks the repo with tree-sitter, extracting functions, classes, and imports from TypeScript, JavaScript, and Python files
2. **Graph** — builds an import graph and call graph across the codebase
3. **Retrieve** — keyword matching + 2-hop import traversal + change memory linkage
4. **Score** — weighted combination of all four signals
5. **Compile** — fills the token budget greedily: full files first, then signature-only, then skip

## Key design decisions

- **No vector database.** Retrieval is keyword matching + graph traversal. Zero infrastructure to set up.
- **No external services.** Everything runs locally. Memory is stored in `.focal/memory.json`.
- **Serializable output.** `FocalContext` is plain JSON — easy to cache, log, and pass to any LLM API.
- **Configurable weights.** Tune scoring without forking.

## V1 scope

Out of scope for V1: real-time file watching, multi-repo support, VS Code plugin, LLM-generated summaries, embedding-based search. These are planned for V2.
