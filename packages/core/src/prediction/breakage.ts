import { CodeGraph, ContextCandidate, PinnedNode } from '../types';

export interface BreakageRisk {
  filePath: string;
  functionId?: string;
  riskScore: number;     // 0–1
  reason: string;
  hopDistance: number;
}

/**
 * Predicts what else might break given a set of changed/pinned files.
 *
 * Uses the inverted call graph (callers) to find everything that depends on
 * the changed code. Returns these as additional ContextCandidates with
 * boosted errorSignal so the agent sees the full blast radius.
 *
 * Why this matters: an agent fixing `validateToken()` should also see
 * `loginHandler()` and `refreshSession()` — not because they contain the bug,
 * but because the fix might break them.
 */
export class BreakagePredictor {
  predict(
    seeds: PinnedNode[],
    graph: CodeGraph,
    existingCandidates: ContextCandidate[]
  ): BreakageRisk[] {
    if (seeds.length === 0) return [];

    // Build inverted call graph: callee → Set<caller>
    const callerIndex = this.buildCallerIndex(graph.callGraph);

    // Build inverted import graph: imported → Set<importer>
    const importerIndex = this.buildImporterIndex(graph.importGraph);

    const risks: BreakageRisk[] = [];
    const visited = new Set<string>();

    // Track already-known candidates to avoid duplicating
    const existingPaths = new Set(existingCandidates.map((c) => c.path));

    // BFS outward from seed files through callers and importers
    type QueueItem = { filePath: string; hop: number; via: string };
    const queue: QueueItem[] = seeds.map((s) => ({
      filePath: s.filePath,
      hop: 0,
      via: 'seed',
    }));

    while (queue.length > 0) {
      const { filePath, hop, via } = queue.shift()!;
      if (hop > 3 || visited.has(filePath)) continue;
      visited.add(filePath);

      if (hop > 0 && graph.files.has(filePath)) {
        // Risk score decays with distance: 0.9, 0.65, 0.35, 0.15
        const riskScore = [0.9, 0.65, 0.35, 0.15][Math.min(hop - 1, 3)];
        const reason = hop === 1
          ? `direct caller/importer of ${via}`
          : `${hop}-hop transitive caller of ${via}`;

        risks.push({ filePath, riskScore, reason, hopDistance: hop });
      }

      // Walk callers (function level)
      const fileNode = graph.files.get(filePath);
      if (fileNode) {
        for (const fn of fileNode.functions) {
          const fnId = `${filePath}::${fn.name}`;
          for (const callerId of callerIndex.get(fnId) ?? new Set<string>()) {
            const callerFile = callerId.split('::')[0];
            if (!visited.has(callerFile) && graph.files.has(callerFile)) {
              queue.push({ filePath: callerFile, hop: hop + 1, via: fn.name });
            }
          }
        }
      }

      // Walk importers (file level)
      for (const importerPath of importerIndex.get(filePath) ?? new Set<string>()) {
        if (!visited.has(importerPath) && graph.files.has(importerPath)) {
          queue.push({ filePath: importerPath, hop: hop + 1, via: filePath });
        }
      }
    }

    // Deduplicate by filePath — keep highest riskScore
    const deduped = new Map<string, BreakageRisk>();
    for (const r of risks) {
      const existing = deduped.get(r.filePath);
      if (!existing || r.riskScore > existing.riskScore) {
        deduped.set(r.filePath, r);
      }
    }

    return [...deduped.values()].sort((a, b) => b.riskScore - a.riskScore);
  }

  /**
   * Convert BreakageRisk results into ContextCandidates that can be merged
   * into the retrieval pipeline.
   */
  toContextCandidates(risks: BreakageRisk[], graph: CodeGraph): ContextCandidate[] {
    return risks
      .filter((r) => graph.files.has(r.filePath))
      .map((r): ContextCandidate => {
        const fileNode = graph.files.get(r.filePath)!;
        return {
          type: 'file',
          path: r.filePath,
          scores: {
            relevance: 0,
            dependency: r.riskScore,
            recency: 0,
            errorSignal: r.riskScore * 0.7, // at-risk files get partial error signal
          },
          finalScore: 0,
          tokenEstimate: Math.ceil(fileNode.size / 4),
          pinned: false,
        };
      });
  }

  private buildCallerIndex(callGraph: Map<string, string[]>): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const [caller, callees] of callGraph) {
      for (const callee of callees) {
        if (!index.has(callee)) index.set(callee, new Set());
        index.get(callee)!.add(caller);
      }
    }
    return index;
  }

  private buildImporterIndex(importGraph: Map<string, string[]>): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const [importer, imports] of importGraph) {
      for (const imported of imports) {
        if (!index.has(imported)) index.set(imported, new Set());
        index.get(imported)!.add(importer);
      }
    }
    return index;
  }
}
