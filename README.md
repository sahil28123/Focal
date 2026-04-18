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

## Multi-repo

Pass an array of paths to build context across multiple repos in a single call:

```typescript
const context = await Focal.build({
  repoPath: ['./frontend', './backend', './shared'],
  query: 'Fix auth token validation bug',
  tokenBudget: 8000,
});
```

All repos are parsed in parallel and merged into a single unified code graph.

## File watching

`Focal.watch()` rebuilds context automatically whenever a file changes. Uses Node's built-in `fs.watch` — no external dependencies.

```typescript
const stop = Focal.watch(
  { repoPath: './my-project', query: 'Fix auth bug' },
  (context) => {
    // called with fresh context on every change
    sendToAgent(context);
  }
);

// tear down when done
stop();
```

Changes are debounced and the parse cache is used so only modified files are re-parsed on each rebuild.

## LLM summaries

When a file is too large for full inclusion but you still want meaningful content in the output, provide a `summarize` callback. Focal calls it with the file content and query — wire it to any LLM you're already using:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  summarize: async (content, query, filePath) => {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Summarize this file in 2-3 sentences, focusing on: ${query}\n\n${content}`
      }]
    });
    return (response.content[0] as { text: string }).text;
  },
});
```

Files with LLM summaries appear in the output with `resolution: 'summary'`.

## Embedding similarity

Provide an `embed` callback to boost relevance scoring with semantic similarity. Focal passes all file texts and the query to your function and blends cosine similarity into the relevance score:

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();

const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  embed: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map(d => d.embedding);
  },
});
```

Without `embed`, Focal uses BM25/TF-IDF scoring — accurate for most codebases with no setup required.

## Scoring signals

Focal ranks files using four signals combined into a weighted score:

| Signal | Default weight | Description |
|---|---|---|
| `relevance` | 0.40 | BM25/TF-IDF match to query across file paths, symbol names, and content; boosted by embedding similarity when `embed` is provided |
| `dependency` | 0.25 | Graph distance from seed files via 2-hop import traversal |
| `errorSignal` | 0.20 | Linkage to past failed attempts stored in change memory |
| `recency` | 0.15 | Exponential decay from last modified time (half-life: 14 days) |

Customize weights:

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

1. **Parse** — walks each repo with tree-sitter, extracting functions, classes, and imports from TypeScript, JavaScript, and Python files; unchanged files are served from an in-memory cache
2. **Graph** — builds a unified import graph and call graph across all repos
3. **Retrieve** — BM25/TF-IDF scoring + optional embedding similarity + 2-hop import traversal + change memory linkage
4. **Score** — weighted combination of all four signals with exponential recency decay
5. **Compile** — fills the token budget greedily: full files → LLM summary (if `summarize` provided) → signature-only → skip

## Key design decisions

- **No external setup.** No vector database, no servers, no infrastructure. Everything runs locally; memory is stored in `.focal/memory.json`.
- **Bring your own LLM.** `summarize` and `embed` are plain async callbacks — wire them to whatever model you're already using. Focal has no hard dependency on any LLM provider.
- **Incremental by default.** A shared parse cache means repeated `build()` calls and `watch()` rebuilds only re-parse files whose mtime has changed.
- **Serializable output.** `FocalContext` is plain JSON — easy to cache, log, and pass to any API.
- **Configurable weights.** Tune scoring without forking.
