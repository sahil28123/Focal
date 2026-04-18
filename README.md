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
console.log(`Confidence: ${context.confidence.verdict} (${(context.confidence.overall * 100).toFixed(0)}%)`);
console.log(`Included ${context.files.length} files in ${context.tokensUsed} tokens`);

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
// context.executionPath — reconstructed call chain through the error
```

Pinned files are always included first, before the token budget is applied to other candidates.

## Execution path modeling

When runtime signals provide two or more pinned nodes, Focal reconstructs the execution path through the call graph — verifying which consecutive frame hops actually exist and filling gaps via import traversal.

```typescript
if (context.executionPath) {
  const { nodes, confidence } = context.executionPath;
  // nodes: PathNode[] — ordered from entry point to error site
  // Each node: { filePath, functionName, line, verified, isErrorSite, isEntryPoint }
  console.log(`Path confidence: ${(confidence * 100).toFixed(0)}%`);
}

// Or let the formatter render it:
const formatter = new FocalFormatter();
const pathBlock = formatter.formatExecutionPath(context, 'xml-tags');
// → <focal_execution_path confidence="83%">
//     <frame path="auth.ts" symbol="validateToken" line="42" error_site="true" />
//     ...
//   </focal_execution_path>
```

The preamble also includes the execution chain automatically:
```
Execution: server.ts::handleRequest → auth.ts::validateToken [ERROR] (path confidence: 83%)
```

## Breakage prediction

For `bug_fix` and `refactor` intents, Focal walks the inverted call graph from pinned nodes to surface callers that are at risk of breaking — up to 3 hops out. These become high-`errorSignal` candidates that automatically compete for budget space.

```typescript
import { BreakagePredictor } from '@focal/core';

const predictor = new BreakagePredictor();
const risks = predictor.predict(pinnedNodes, graph, existingCandidates);
// risks[n]: { filePath, functionName, riskScore, hopDistance, reason }
```

Risk scores: `0.90` (direct caller) → `0.65` (1 hop) → `0.35` (2 hops) → `0.15` (3 hops). Files are automatically included in the context when their risk score is high enough to win a budget slot.

## Confidence estimation

Every context object carries a `confidence` field — a 5-signal composite score that tells you how trustworthy the context is before you pay for an LLM call.

```typescript
const { overall, verdict, breakdown, warnings } = context.confidence;
// verdict: 'high' | 'medium' | 'low'
// breakdown: { signalCoverage, topCandidateScore, memoryPatternHits, budgetUtilization, diversityScore }
// warnings: string[]  — human-readable issues (e.g., "Top candidate score < 0.3 — query may be too vague")

if (context.confidence.verdict === 'low') {
  // Query is too vague, or no runtime signals — consider adding a stack trace
}
```

| Signal | Weight | Meaning |
|---|---|---|
| `signalCoverage` | 0.30 | Fraction of pinned nodes with high-scoring candidates |
| `topCandidateScore` | 0.30 | Score of the best candidate after intent weighting |
| `memoryPatternHits` | 0.15 | How many past failures matched this query |
| `budgetUtilization` | 0.15 | How efficiently the token budget was filled |
| `diversityScore` | 0.10 | File-path diversity of included context |

## Failure pattern index

Focal's memory layer includes a failure pattern index that learns from past builds marked as failures. Future queries that resemble past failure descriptions automatically boost those files' `errorSignal` scores — no manual tagging required.

```typescript
import { FailurePatternIndex } from '@focal/core';

const index = new FailurePatternIndex();
index.build(memoryRecords);  // built automatically inside Focal.build()

// getBoosts returns a Map<filePath, boost> for files that match the query
const boosts = index.getBoosts('Fix auth token expiry crash');

// matchCount: how many past failure records matched (used in confidence score)
const hits = index.matchCount('Fix auth token expiry crash');
```

Matching uses Jaccard similarity on tokenized descriptions (threshold 0.15). Records decay with a 21-day half-life so stale failures don't dominate forever.

## Diversity ranking

Focal applies Maximal Marginal Relevance (MMR) after scoring to prevent a single cluster of closely related files from consuming the entire token budget. λ=0.3 balances relevance against diversity.

```typescript
import { DiversityRanker } from '@focal/core';

const ranker = new DiversityRanker();
const reranked = ranker.rerank(scored);  // called internally by Scorer

// Standalone diversity score — used by ConfidenceEstimator
const diversity = DiversityRanker.diversityScore(filePaths);
```

Diversity is computed from file path segments — files in different directories are considered more diverse than files in the same directory.

## Function-level retrieval

Focal indexes every function and class individually using BM25. When one function in a file scores significantly higher than the rest, Focal includes only that function as a snippet rather than the entire file.

```
// Before (file-level): 600-line auth service → 600 tokens of noise
// After  (function-level): validateToken() → 40-token snippet, score 0.91

context.files[n].resolution  // 'snippet' | 'full' | 'signature-only' | 'summary'
context.files[n].snippet      // { symbol, startLine, endLine }
```

This directly reduces token usage while increasing the precision of what the agent sees.

## Agent sessions

`FocalSession` manages multi-iteration agent loops. On each iteration it adapts the context config automatically — expanding the budget and sharpening focus when the agent is struggling.

```typescript
import { FocalSession } from '@focal/core';

const session = new FocalSession({
  repoPath: './my-project',
  query: 'Fix token validation crash',
  tokenBudget: 6000,
});

// Iteration 0 — initial context
const context = await session.next();
await agent.run(context);

// Agent failed — record and retry with adapted config
session.recordOutcome('failure', ['src/auth.ts'], 'Missing expiry check');
const context2 = await session.next();  // +25% budget, augmented query

// Agent failed again — focused mode
session.recordOutcome('failure', ['src/auth.ts']);
const context3 = await session.next();  // +50% budget, forced bug_fix intent, errorSignal 0.50

console.log(session.summary());
// { iterations: 3, totalTokensUsed: 14500, outcome: 'in_progress' }
```

| Phase | Trigger | Behavior |
|---|---|---|
| `initial` | Iteration 0 | Base config as provided |
| `retry` | Iterations 1–2 | +25% budget, query augmented with failed file names |
| `focused` | Iteration 3+ | +50% budget, `errorSignal` weight 0.50, intent forced to `bug_fix` |

## Incremental context

For stable agent loops where most files don't change between iterations, `buildIncremental` returns only the delta — files added, changed, or removed. Saves 60–80% tokens on typical retries.

```typescript
import { buildIncremental } from '@focal/core';

const first = await Focal.build(config);
// ... agent makes edits ...
const delta = await buildIncremental(config, first);

// delta.added   — new files not in previous context
// delta.changed — files with different content
// delta.removed — files in previous context but no longer relevant
// delta.unchanged — still relevant, not re-sent (saves tokens)
// delta.tokensSaved — estimated tokens saved vs. full rebuild
```

Use `buildIncremental` in retry loops where the codebase is mostly stable — the agent only needs to see what changed.

## Enriched summarization

When a file is too large for full inclusion, the `summarizeEnriched` callback receives structured relationship context alongside the file content. This lets your summarization prompt focus on the parts that matter to the current context.

```typescript
const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  summarizeEnriched: async (input) => {
    // input.role: 'error_site' | 'dependency' | 'caller' | 'related'
    // input.relationships.importedByInContext  — other context files that import this
    // input.relationships.importsInContext     — dependencies already in context
    // input.relationships.calledBySymbols      — functions in context that call into this
    // input.relationships.callsSymbols         — functions this file calls in context
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `This file is a ${input.role} for: ${input.query}.
Called by: ${input.relationships.calledBySymbols.join(', ')}.
Summarize focusing on: ${input.relationships.callsSymbols.join(', ')}.

${input.content}`,
      }],
    });
    return (res.content[0] as { text: string }).text;
  },
});
```

Use `summarize` for a simpler callback with just `(content, query, filePath)`.

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
// <focal_preamble>
// Query:      Fix auth token validation bug
// Intent:     bug_fix (94% confidence)
// Confidence: high (78%)
// Context:    7 files — 5420/8000 tokens
// Execution:  server.ts::handleRequest → auth.ts::validateToken [ERROR] (83%)
// </focal_preamble>
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
| `errorSignal` | Runtime signal boosts (stack trace, test failure, git diff) + failure pattern index + past failure linkage from memory |
| `recency` | Exponential decay from last modified time — half-life 14 days |

Default weights are overridden by the detected intent profile. Manual overrides via `config.weights`.

## How it works

1. **Classify** — query is classified into `bug_fix`, `feature`, `refactor`, or `understand`; scoring weights adjust automatically
2. **Ingest signals** — stack traces, test failures, and git diffs are parsed into pinned nodes with per-frame error boosts
3. **Parse** — tree-sitter walks each repo; unchanged files are served from an in-memory mtime cache
4. **Graph** — unified import graph + call graph built across all repos
5. **Execution path** — pinned nodes are cross-referenced with the call graph to reconstruct the verified call chain through the error
6. **Retrieve** — function-level BM25 index; intent-aware call graph traversal (callers for `bug_fix`, callees for `feature`); failure pattern index applied; breakage prediction adds at-risk callers; memory linkage
7. **Score** — intent-weighted profile applied; MMR diversity reranking prevents cluster dominance
8. **Compile** — knapsack VPT allocation: all (candidate × resolution) pairs sorted by value-per-token; budget filled greedily — function snippets, full files, enriched summaries, and signatures compete on equal footing
9. **Confidence** — 5-signal composite score computed; warnings generated for low-confidence builds
10. **Format** — `FocalFormatter` assembles the final prompt in xml-tags, markdown, or plain

## Key design decisions

- **No external setup.** No vector database, no servers, no infrastructure. Everything runs locally.
- **Bring your own LLM.** `summarize`, `summarizeEnriched`, and `embed` are async callbacks — Focal has no hard dependency on any provider.
- **Function-level by default.** BM25 indexes individual functions; one relevant function in a 600-line file costs ~40 tokens, not 600.
- **Intent-aware scoring.** Weights shift per task type — a bug fix and a refactor use completely different scoring profiles.
- **Blast radius visibility.** Breakage predictor surfaces callers of changed code; execution path shows the verified call chain to the error site.
- **Adaptive agent loops.** `FocalSession` escalates budget and sharpens focus automatically across iterations — no manual tuning.
- **Incremental by default.** Parse cache keyed by mtime; `watch()` only re-parses changed files; `buildIncremental()` skips unchanged context entirely.
- **Serializable output.** `FocalContext` is plain JSON — cache it, log it, pass it to any API.
