import * as path from 'path';
import { ContextCandidate } from '../types';

/**
 * Maximal Marginal Relevance reranker — prevents context from being dominated
 * by one cluster of the codebase.
 *
 * Without diversity: 8 files from src/auth/, nothing from src/db/ or src/api/
 * With diversity:    top file from each component, then fill remaining budget
 *
 * MMR formula: score(c) - λ * max_sim(c, already_selected)
 * λ = 0.3  (favor relevance; diversity is a soft penalty, not a hard rule)
 *
 * Similarity between candidates is structural: same top-level directory = 0.8,
 * same second-level directory = 0.5, different = 0.0.
 */
export class DiversityRanker {
  private lambda = 0.3;

  rerank(candidates: ContextCandidate[]): ContextCandidate[] {
    if (candidates.length <= 3) return candidates;

    // Pinned candidates are always kept first in original order
    const pinned = candidates.filter((c) => c.pinned);
    const unpinned = candidates.filter((c) => !c.pinned);

    const reranked = this.mmr(unpinned);
    return [...pinned, ...reranked];
  }

  private mmr(candidates: ContextCandidate[]): ContextCandidate[] {
    if (candidates.length === 0) return [];

    const selected: ContextCandidate[] = [];
    const remaining = [...candidates];

    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        const relevance = c.finalScore;

        // Max similarity to any already-selected candidate
        const maxSim = selected.length > 0
          ? Math.max(...selected.map((s) => this.structuralSimilarity(c.path, s.path)))
          : 0;

        const mmrScore = relevance - this.lambda * maxSim;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
  }

  /**
   * Structural similarity between two file paths.
   * Same top-level dir = 0.8, same second-level = 0.5, same file base = 0.95, different = 0.0
   */
  private structuralSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;

    const aParts = a.split(path.sep).filter(Boolean);
    const bParts = b.split(path.sep).filter(Boolean);

    // Find common prefix length
    let common = 0;
    const min = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < min; i++) {
      if (aParts[i] === bParts[i]) common++;
      else break;
    }

    const depth = Math.max(aParts.length, bParts.length);
    if (common === 0) return 0;
    // Similarity grows with common depth relative to total depth
    return (common / depth) * 0.9;
  }

  /**
   * Compute a diversity score for an already-compiled list of files.
   * Used by ConfidenceEstimator — returns 0–1.
   */
  static diversityScore(filePaths: string[]): number {
    if (filePaths.length <= 1) return filePaths.length === 1 ? 1 : 0;

    const topDirs = new Set(
      filePaths.map((p) => {
        const parts = p.split(path.sep).filter(Boolean);
        // Use the last "src-relative" meaningful directory
        const srcIdx = parts.lastIndexOf('src');
        const base = srcIdx >= 0 ? parts[srcIdx + 1] : parts[parts.length - 2];
        return base ?? 'root';
      })
    );

    // Normalized: 1 dir out of n files = low diversity, n dirs = high diversity
    return Math.min(1, topDirs.size / Math.max(filePaths.length * 0.6, 1));
  }
}
