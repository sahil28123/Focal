import * as path from 'path';
import { PinnedNode } from '../types';

function resolve(filePath: string, repoPaths: string[]): string {
  if (path.isAbsolute(filePath)) return filePath;
  return repoPaths.length > 0 ? path.resolve(repoPaths[0], filePath) : filePath;
}

export function parseTestOutput(output: string, repoPaths: string[]): PinnedNode[] {
  const pinned: PinnedNode[] = [];
  const seen = new Set<string>();

  const add = (rawPath: string, symbol?: string) => {
    const resolved = resolve(rawPath, repoPaths);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    pinned.push({
      filePath: resolved,
      symbol,
      source: 'test_failure',
      errorSignalBoost: 0.8,
    });
  };

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    // Jest / Vitest: "FAIL src/auth/login.test.ts"
    const jestFile = trimmed.match(/^(?:FAIL|FAILED)\s+([\w/._-]+\.[jt]sx?)/);
    if (jestFile) { add(jestFile[1]); continue; }

    // Jest inline failure path: "  ● Auth > validateToken"
    // Usually followed by a file path line — handled by the next pattern

    // Jest stack inside test: "      at Object.<anonymous> (src/auth/token.ts:12:5)"
    const jestStack = trimmed.match(/at\s+[\w.<>]+\s+\(([\w/._-]+\.[jt]sx?):(\d+)/);
    if (jestStack) { add(jestStack[1]); continue; }

    // pytest: "FAILED tests/test_auth.py::TestAuth::test_validate_token"
    const pytestFail = trimmed.match(/^FAILED\s+([\w/._-]+\.py)(?:::(\w+))?/);
    if (pytestFail) { add(pytestFail[1], pytestFail[2]); continue; }

    // pytest collection error: "ERROR tests/test_auth.py"
    const pytestErr = trimmed.match(/^ERROR\s+([\w/._-]+\.py)/);
    if (pytestErr) { add(pytestErr[1]); continue; }

    // Go test file reference: "        auth_test.go:42: some message"
    const goRef = trimmed.match(/^([\w/._-]+_test\.go):\d+/);
    if (goRef) { add(goRef[1]); continue; }

    // Ruby RSpec: "rspec ./spec/auth_spec.rb:42"
    const rspecRef = trimmed.match(/rspec\s+([\w/._-]+_spec\.rb)(?::\d+)?/);
    if (rspecRef) { add(rspecRef[1]); continue; }
  }

  return pinned;
}
