import { TaskIntent, TaskIntentType, RuntimeSignals } from '../types';

const BUG_KEYWORDS = [
  'fix', 'bug', 'error', 'crash', 'fail', 'failing', 'broken', 'exception',
  'traceback', 'typeerror', 'attributeerror', 'valueerror', 'keyerror',
  'referenceerror', 'cannot', "can't", 'wrong', 'incorrect', 'not working',
  'issue', 'problem', 'debug', 'undefined', 'null pointer', 'segfault',
  'panic', 'unhandled', 'unexpected',
];
const FEATURE_KEYWORDS = [
  'add', 'implement', 'build', 'create', 'support', 'integrate', 'introduce',
  'develop', 'write', 'new feature', 'extend', 'enable', 'allow',
];
const REFACTOR_KEYWORDS = [
  'refactor', 'rename', 'extract', 'move', 'clean', 'simplify', 'decouple',
  'reorganize', 'restructure', 'split', 'consolidate', 'rewrite', 'improve',
  'optimiz', 'abstract', 'generalize', 'modularize',
];
const UNDERSTAND_KEYWORDS = [
  'how does', 'how do', 'what is', 'what does', 'explain', 'understand',
  'trace', 'why does', 'where is', 'show me', 'describe', 'walk through',
  'find where', 'locate',
];

// Stack trace line patterns — matches across Node, Python, Go, Java
const STACK_LINE_PATTERNS = [
  /\bat\s+(?:\S+\s+)?\(([^)]+):\d+:\d+\)/,    // Node.js with symbol
  /\bat\s+([\w/._-]+\.[jt]sx?):\d+/,           // Node.js bare
  /File\s+"([^"]+)",\s+line\s+\d+/,            // Python
  /^\s+([\w/._-]+\.go):\d+/,                    // Go
  /\bat\s+[\w.$]+\((\w+\.java):\d+\)/,          // Java
];

function countKeywords(lower: string, keywords: string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits;
}

function extractStackFiles(text: string): string[] {
  const files: string[] = [];
  for (const line of text.split('\n')) {
    for (const pattern of STACK_LINE_PATTERNS) {
      const m = line.match(pattern);
      if (m?.[1]) { files.push(m[1]); break; }
    }
  }
  return [...new Set(files)];
}

function hasLikelyStackTrace(text: string): boolean {
  return STACK_LINE_PATTERNS.some((p) => p.test(text));
}

export class IntentClassifier {
  classify(query: string, runtimeSignals?: RuntimeSignals): TaskIntent {
    const combined = [
      query,
      runtimeSignals?.errorMessage ?? '',
      runtimeSignals?.stackTrace ? '[stack trace present]' : '',
      runtimeSignals?.testOutput ? '[test output present]' : '',
    ].join(' ');
    const lower = combined.toLowerCase();

    const hasStack = !!(
      runtimeSignals?.stackTrace && hasLikelyStackTrace(runtimeSignals.stackTrace)
    );
    const hasTestFail = !!(
      runtimeSignals?.testOutput && /\bfail|\berror|\bFAILED/i.test(runtimeSignals.testOutput)
    );

    const scores: Record<TaskIntentType, number> = {
      bug_fix:    countKeywords(lower, BUG_KEYWORDS)       + (hasStack ? 4 : 0) + (hasTestFail ? 3 : 0),
      feature:    countKeywords(lower, FEATURE_KEYWORDS),
      refactor:   countKeywords(lower, REFACTOR_KEYWORDS),
      understand: countKeywords(lower, UNDERSTAND_KEYWORDS),
    };

    const entries = Object.entries(scores) as [TaskIntentType, number][];
    entries.sort((a, b) => b[1] - a[1]);
    const [topType, topScore] = entries[0];
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;

    const stackFiles = runtimeSignals?.stackTrace
      ? extractStackFiles(runtimeSignals.stackTrace)
      : [];

    // Domain terms: significant words from query not in signal keyword lists
    const allSignalWords = new Set([
      ...BUG_KEYWORDS, ...FEATURE_KEYWORDS, ...REFACTOR_KEYWORDS, ...UNDERSTAND_KEYWORDS,
    ]);
    const domain = query
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3 && !allSignalWords.has(t.toLowerCase()))
      .slice(0, 6);

    // Target symbols: camelCase or snake_case identifiers
    const targetSymbols = [
      ...(query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? []),
      ...(query.match(/\b[a-z][a-z0-9]+_[a-z][a-z0-9_]+\b/g) ?? []),
    ];

    return {
      type: topType,
      confidence: Math.min(1, topScore / total),
      signals: {
        errorPatterns: hasStack ? ['stack_trace'] : hasTestFail ? ['test_failure'] : [],
        stackFiles,
        domain,
        targetSymbols,
      },
    };
  }

  /** Use a caller-specified intent type but still extract signals from query. */
  fromType(type: TaskIntentType, query: string, runtimeSignals?: RuntimeSignals): TaskIntent {
    const detected = this.classify(query, runtimeSignals);
    return { ...detected, type, confidence: 1 };
  }
}
