import { ChangeRecord } from '../types';

interface FailurePattern {
  queryTokens: string[];
  files: string[];
  timestamp: number;
  weight: number;  // recency-weighted; recent failures count more
}

const RECENCY_HALF_LIFE_DAYS = 21;  // failures older than 3 weeks fade

/**
 * Extracts patterns from past failures and uses them to boost future retrieval.
 *
 * Core insight: if `validateToken` failed 3 times last week when fixing JWT bugs,
 * and today's query is about JWT expiry, those files should score higher even if
 * the BM25 match is only moderate.
 *
 * Algorithm:
 *   1. Index all failure records: queryTokens → files
 *   2. On new query: Jaccard(currentTokens, storedTokens) × recencyWeight → file boost
 *   3. Boosts are additive — multiple matching patterns compound
 */
export class FailurePatternIndex {
  private patterns: FailurePattern[] = [];

  build(records: ChangeRecord[]): void {
    this.patterns = records
      .filter((r) => r.outcome === 'failure' || r.type === 'failed_attempt')
      .map((r) => {
        const ageDays = (Date.now() - r.timestamp) / (1000 * 60 * 60 * 24);
        const weight = Math.exp(-Math.LN2 * ageDays / RECENCY_HALF_LIFE_DAYS);
        return {
          queryTokens: tokenize(r.description),
          files: r.files,
          timestamp: r.timestamp,
          weight,
        };
      })
      .filter((p) => p.weight > 0.05 && p.queryTokens.length > 0);
  }

  /**
   * Return a boost map: filePath → additional errorSignal boost from past failures.
   * Values are 0–1 and should be added (clamped) to existing errorSignal scores.
   */
  getBoosts(query: string): Map<string, number> {
    const boosts = new Map<string, number>();
    if (this.patterns.length === 0) return boosts;

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return boosts;

    for (const pattern of this.patterns) {
      const similarity = jaccard(queryTokens, pattern.queryTokens);
      if (similarity < 0.15) continue;  // too dissimilar — skip

      const boost = similarity * pattern.weight;
      for (const file of pattern.files) {
        boosts.set(file, Math.min(1, (boosts.get(file) ?? 0) + boost));
      }
    }

    return boosts;
  }

  /** How many patterns matched for a query (for confidence estimation). */
  matchCount(query: string): number {
    const tokens = tokenize(query);
    return this.patterns.filter((p) => jaccard(tokens, p.queryTokens) >= 0.15).length;
  }

  get size(): number {
    return this.patterns.length;
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
