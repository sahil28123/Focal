# Focal

**Give your coding agent only the code it needs.**

Focal is an open-source TypeScript library and CLI that builds optimized context packages for LLM-powered coding agents. Given a repo path and a task description, Focal parses the codebase into a code graph, scores every file and function by relevance to the task, and returns a structured context object — ready to send to Claude, GPT-4, or any LLM API — that fits within a token budget.

## Install

```bash
npm install @focal/core
```

## Basic usage

```typescript
import { Focal, FocalFormatter } from '@focal/core';

const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  tokenBudget: 6000,
});

console.log(`Intent: ${context.intent.type}`);
console.log(`Included ${context.files.length} files in ${context.tokensUsed} tokens`);
console.log(context.summary);

// Format for Claude (xml-tags), GPT-4 (markdown), or others (plain)
const formatter = new FocalFormatter();
const prompt = formatter.toPrompt(context, { style: 'xml-tags' });

const response = await anthropic.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 2048,
  messages: [{ role: 'user', content: prompt + `\n\nTask: ${context.query}` }],
});
```

## CLI

```bash
# Build context — intent is auto-detected from the query
focal build --repo ./my-project --query "Fix login bug" --budget 6000

# Pass runtime signals to pin error sites and boost their scores
focal build --repo ./my-project --query "Fix login bug" \
  --stack-trace ./error.txt \
  --test-output ./jest-output.txt \
  --diff ./git-diff.txt

# Override intent detection
focal build --repo ./my-project --query "Add OAuth support" --intent feature

# Write formatted output (json | xml-tags | markdown | plain)
focal build --repo ./my-project --query "Fix login bug" \
  --output context.xml --format xml-tags

# Multi-repo
focal build --repo ./frontend ./backend ./shared --query "Fix auth bug"

# Memory
focal memory add --repo ./my-project --description "Fixed token validation" --files "src/auth.ts"
focal memory ingest-diff --repo ./my-project --description "Auth refactor" --diff ./diff.txt
focal memory outcome --repo ./my-project --id <record-id> --outcome failure
focal memory list --repo ./my-project
```

## Intent detection

Focal classifies every query into one of four task types and adjusts its scoring weights automatically — no configuration required.

| Intent | Detected when | Scoring emphasis |
|---|---|---|
| `bug_fix` | query mentions "fix", "error", "crash"; or runtime signals present | `errorSignal` 0.40 — stack trace sites dominate |
| `feature` | query mentions "add", "implement", "build" | `dependency` 0.35 — understand what already exists |
| `refactor` | query mentions "rename", "extract", "simplify" | `dependency` 0.45 — find everything that will break |
| `understand` | query mentions "how does", "explain", "trace" | `relevance` 0.55 — bring the most explanatory code |

Override detection with `config.intent` or `--intent` on the CLI.

## Runtime signals

Pass stack traces, test failures, or git diffs to pin the files closest to the error and give them a boosted `errorSignal` score. Parsers cover Node.js, Python, Go, Java, and Rust.

```typescript
const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix token validation crash',
  runtimeSignals: {
    stackTrace: fs.readFileSync('./error.txt', 'utf8'),
    testOutput: fs.readFileSync('./jest-output.txt', 'utf8'),
    recentDiff: execSync('git diff --name-only HEAD~3').toString(),
  },
});

// context.pinnedFiles — files forced in from stack trace / test failures
// context.files[n].runtimeContext.appearsInStackTrace — true for error sites
```

Pinned files are always included first, before the token budget is applied to other candidates.

## Function-level retrieval

Focal indexes every function and class individually using BM25. When one function in a file scores significantly higher than the rest, Focal includes only that function as a snippet rather than the entire file.

```
// Before (file-level): 600-line auth service → 600 tokens of noise
// After  (function-level): validateToken() → 40-token snippet, score 0.91

context.files[n].resolution  // 'snippet' | 'full' | 'signature-only' | 'summary'
context.files[n].snippet      // { symbol, startLine, endLine }
```

This directly reduces token usage while increasing the precision of what the agent sees.

## Output formatting

`FocalFormatter` turns a `FocalContext` into a ready-to-use prompt string. Pick the style that matches your model:

```typescript
import { FocalFormatter } from '@focal/core';

const formatter = new FocalFormatter();

// Claude — xml-tags (recommended; Claude is trained to reason about tag boundaries)
const claudePrompt = formatter.toPrompt(context, { style: 'xml-tags', includeReasons: true });

// GPT-4 — markdown
const gptPrompt = formatter.toPrompt(context, { style: 'markdown' });

// Any model — plain text
const plainPrompt = formatter.toPrompt(context, { style: 'plain' });

// Just the preamble (for use in system prompt)
const preamble = formatter.toPreamble(context);
```

Each file in the output includes its `reason` (why it was included), `relatedSymbols` (other exports in that file), and for pinned files, which signal triggered the pin.

## Memory

Focal records every build automatically. No manual input needed.

```typescript
import { MemoryAutoCollector, MemoryStore } from '@focal/core';

const store = new MemoryStore();
await store.init('./.focal');
const collector = new MemoryAutoCollector(store);

// Auto-record a build (called internally by Focal.build())
const id = await collector.recordBuild(context);

// Mark outcome — failure boosts errorSignal for those files in future queries
await collector.recordOutcome(id, 'failure');

// Ingest a git diff
await collector.ingestDiff(diff, 'Refactored auth module', './my-project');
```

Memory is stored in `.focal/memory.json` with a 500-record LRU cap and an in-memory inverted index for O(1) file lookups. The `.focal/` directory is added to `.gitignore` automatically on first init.

## Multi-repo

```typescript
const context = await Focal.build({
  repoPath: ['./frontend', './backend', './shared'],
  query: 'Fix auth token validation bug',
  tokenBudget: 8000,
});
```

All repos are parsed in parallel and merged into a single unified code graph. Each `IncludedFile` carries a `repoRoot` field so you always know which repo a file came from.

## File watching

```typescript
const stop = Focal.watch(
  { repoPath: './my-project', query: 'Fix auth bug' },
  (context) => sendToAgent(context),
  (err) => console.error(err),
);

stop(); // tear down
```

Uses Node's built-in `fs.watch` — zero external dependencies. File changes are debounced (300ms) and only modified files are re-parsed on each rebuild.

## LLM summaries

When a file is too large for full inclusion, provide a `summarize` callback. Focal calls it only when needed — wire it to any model you're already using:

```typescript
const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  summarize: async (content, query, filePath) => {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Summarize this file for: ${query}\n\n${content}`,
      }],
    });
    return (res.content[0] as { text: string }).text;
  },
});
```

## Embedding similarity

```typescript
const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  embed: async (texts) => {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
    return res.data.map(d => d.embedding);
  },
});
```

Without `embed`, Focal uses BM25 — accurate for most codebases with no setup.

## Scoring signals

| Signal | Description |
|---|---|
| `relevance` | BM25 score computed at function level; blended with embedding cosine similarity when `embed` is provided |
| `dependency` | Graph distance via 2-hop import traversal + intent-aware call graph traversal |
| `errorSignal` | Runtime signal boosts (stack trace, test failure, git diff) + past failure linkage from memory |
| `recency` | Exponential decay from last modified time — half-life 14 days |

Default weights are overridden by the detected intent profile. Manual overrides via `config.weights`.

## How it works

1. **Classify** — query is classified into `bug_fix`, `feature`, `refactor`, or `understand`; scoring weights adjust automatically
2. **Ingest signals** — stack traces, test failures, and git diffs are parsed into pinned nodes with per-frame error boosts
3. **Parse** — tree-sitter walks each repo; unchanged files are served from an in-memory mtime cache
4. **Graph** — unified import graph + call graph built across all repos
5. **Retrieve** — function-level BM25 index; intent-aware call graph traversal (callers for `bug_fix`, callees for `feature`); runtime boosts applied; memory linkage
6. **Score** — intent-weighted profile applied; pinned nodes sort first
7. **Compile** — knapsack VPT allocation: all (candidate × resolution) pairs sorted by value-per-token; budget filled greedily — function snippets, full files, LLM summaries, and signatures compete on equal footing
8. **Format** — `FocalFormatter` assembles the final prompt in xml-tags, markdown, or plain

## Key design decisions

- **No external setup.** No vector database, no servers, no infrastructure. Everything runs locally.
- **Bring your own LLM.** `summarize` and `embed` are async callbacks — Focal has no hard dependency on any provider.
- **Function-level by default.** BM25 indexes individual functions; one relevant function in a 600-line file costs ~40 tokens, not 600.
- **Intent-aware scoring.** Weights shift per task type — a bug fix and a refactor use completely different scoring profiles.
- **Incremental.** Parse cache keyed by mtime; `watch()` only re-parses changed files.
- **Serializable output.** `FocalContext` is plain JSON — cache it, log it, pass it to any API.
