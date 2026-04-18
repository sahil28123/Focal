import * as path from 'path';
import { PinnedNode } from '../types';

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|java|rb|rs|cs|cpp|c)$/;

export function parseGitDiff(diff: string, repoPaths: string[]): PinnedNode[] {
  const pinned: PinnedNode[] = [];
  const seen = new Set<string>();

  for (const line of diff.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Handles both --name-only and --stat ("src/auth.ts | 12 ++-")
    const filePath = trimmed.split(/\s+\|\s+/)[0].trim();

    if (!SOURCE_EXTENSIONS.test(filePath)) continue;

    const resolved = repoPaths.length > 0
      ? path.resolve(repoPaths[0], filePath)
      : filePath;

    if (seen.has(resolved)) continue;
    seen.add(resolved);

    pinned.push({
      filePath: resolved,
      source: 'git_diff',
      // Moderate boost — changed recently but not necessarily an error site
      errorSignalBoost: 0.45,
    });
  }

  return pinned;
}
