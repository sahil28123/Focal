import { RuntimeSignals, PinnedNode } from '../types';
import { parseStackTrace } from './stack-trace';
import { parseTestOutput } from './test-runner';
import { parseGitDiff } from './git';

export { parseStackTrace } from './stack-trace';
export { parseTestOutput } from './test-runner';
export { parseGitDiff } from './git';

export interface IngestedSignals {
  pinnedNodes: PinnedNode[];
  /** filePath -> highest errorSignalBoost from any signal source */
  boostMap: Map<string, number>;
}

export class RuntimeSignalIngester {
  ingest(signals: RuntimeSignals, repoPaths: string[]): IngestedSignals {
    const all: PinnedNode[] = [];

    if (signals.stackTrace) {
      all.push(...parseStackTrace(signals.stackTrace, repoPaths));
    }
    if (signals.testOutput) {
      all.push(...parseTestOutput(signals.testOutput, repoPaths));
    }
    if (signals.recentDiff) {
      all.push(...parseGitDiff(signals.recentDiff, repoPaths));
    }

    // Highest boost per file wins
    const boostMap = new Map<string, number>();
    for (const node of all) {
      const prev = boostMap.get(node.filePath) ?? 0;
      boostMap.set(node.filePath, Math.max(prev, node.errorSignalBoost));
    }

    return { pinnedNodes: all, boostMap };
  }
}
