⚡ Focal
Give your coding agent only the code it actually needs.
🚨 The problem

LLM coding agents are dumb in one specific way:

They see too much code.

❌ Entire files
❌ Irrelevant dependencies
❌ Old context
❌ Noise everywhere

Result:

wrong fixes
hallucinations
wasted tokens
⚡ The fix

Focal turns your repo into high-signal context.

✅ Only relevant functions
✅ Error-linked code paths
✅ Runtime-aware context
✅ Token-optimized output
🧠 What it actually does

Given:

"Fix auth token validation crash"

Focal will:

🧠 detect intent (bug_fix)
📍 extract stack trace + failing files
🔗 reconstruct execution path
⚠️ predict what else might break
✂️ select only high-value code (function-level)
📦 fit everything inside token budget
🔥 Example
Before (what most tools send)
// auth.ts (600 lines)
// middleware.ts (400 lines)
// utils.ts (300 lines)

👉 1300+ lines
👉 mostly noise

After (Focal)
// auth.ts
function validateToken(...) { ... }   // error site

// middleware.ts
function authMiddleware(...) { ... }  // caller

// execution path:
server.ts → auth.ts::validateToken ❌

👉 ~80 tokens
👉 maximum signal

⚡ Quick start
npm install @focal/core
import { Focal, FocalFormatter } from '@focal/core';

const context = await Focal.build({
  repoPath: './repo',
  query: 'Fix token validation crash',
});

const prompt = new FocalFormatter().toPrompt(context, {
  style: 'xml-tags'
});
🧠 Why Focal is different
1. Runtime-aware (this is the killer)
--stack-trace
--test-output
--diff

Focal doesn’t guess — it follows the error.

2. Function-level precision
❌ whole file (600 lines)
✅ exact function (~40 tokens)
3. Execution path modeling
server.ts → auth.ts::validateToken ❌

LLMs understand flows, not just files.

4. Breakage prediction

Finds:

"what else might break if this changes"
5. Value-per-token optimization

Every token earns its place.

6. Adaptive agent loops
session.next()
retries → more focus
failures → better context
7. 100% local-first
❌ no vector DB
❌ no infra
❌ no setup

Just run it.

🧪 Real impact
🔻 60–80% fewer tokens
⚡ faster responses
🎯 more accurate fixes
🧩 Works with
Claude
GPT-4
Cursor
any LLM API
🔥 Mental model

Focal is not:

❌ memory
❌ RAG
❌ search

It is:

🧠 A compiler for LLM context