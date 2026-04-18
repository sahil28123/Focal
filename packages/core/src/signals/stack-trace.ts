import * as path from 'path';
import { PinnedNode } from '../types';

interface StackFrame {
  rawPath: string;
  line: number;
  symbol?: string;
}

// Each parser returns a StackFrame or null for a single line.
// Order matters — more specific patterns first.
const LINE_PARSERS: Array<(line: string) => StackFrame | null> = [
  // Node.js with symbol: "    at validateToken (src/auth/token.ts:42:8)"
  (l) => {
    const m = l.match(/\bat\s+([\w.<>$[\] ]+)\s+\(([^)]+):(\d+):\d+\)/);
    if (!m) return null;
    return { rawPath: m[2], line: parseInt(m[3]), symbol: m[1].trim() };
  },
  // Node.js bare: "    at src/auth/token.ts:42:8"
  (l) => {
    const m = l.match(/\bat\s+([\w/._-]+\.[jt]sx?):(\d+):\d+/);
    if (!m) return null;
    return { rawPath: m[1], line: parseInt(m[2]) };
  },
  // Python: '  File "src/auth/token.py", line 42, in validate_token'
  (l) => {
    const m = l.match(/File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\w+))?/);
    if (!m) return null;
    return { rawPath: m[1], line: parseInt(m[2]), symbol: m[3] };
  },
  // Go: "        src/auth/token.go:42 +0x1a2"
  (l) => {
    const m = l.match(/^\s+([\w/._-]+\.go):(\d+)/);
    if (!m) return null;
    return { rawPath: m[1], line: parseInt(m[2]) };
  },
  // Java: "    at com.example.Auth.validateToken(Auth.java:42)"
  (l) => {
    const m = l.match(/\bat\s+[\w.$]+\.(\w+)\((\w+\.java):(\d+)\)/);
    if (!m) return null;
    return { rawPath: m[2], line: parseInt(m[3]), symbol: m[1] };
  },
  // Rust: "   0: project::auth::validate_token"
  // Rust panics usually show file in a separate line; handle the file line:
  (l) => {
    const m = l.match(/^\s+at\s+([\w/._-]+\.rs):(\d+)/);
    if (!m) return null;
    return { rawPath: m[1], line: parseInt(m[2]) };
  },
];

function resolveFrame(rawPath: string, repoPaths: string[]): string {
  if (path.isAbsolute(rawPath)) return rawPath;
  // Try each repo root
  for (const rp of repoPaths) {
    return path.resolve(rp, rawPath);
  }
  return rawPath;
}

export function parseStackTrace(stackTrace: string, repoPaths: string[]): PinnedNode[] {
  const frames: StackFrame[] = [];

  for (const line of stackTrace.split('\n')) {
    for (const parser of LINE_PARSERS) {
      const frame = parser(line);
      if (frame) { frames.push(frame); break; }
    }
  }

  const pinned: PinnedNode[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const resolved = resolveFrame(frame.rawPath, repoPaths);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    // Frames closer to the error site (lower index) get higher boost
    const boost = Math.max(0.4, 1.0 - i * 0.12);

    pinned.push({
      filePath: resolved,
      symbol: frame.symbol,
      line: frame.line,
      source: 'stack_trace',
      errorSignalBoost: boost,
    });
  }

  return pinned;
}
