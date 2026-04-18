import { ContextCandidate, FocalConfig, TaskIntent, TaskIntentType } from '../types';
import { DiversityRanker } from './diversity';

const AGE_HALF_LIFE_DAYS = 14;

type Weights = Required<NonNullable<FocalConfig['weights']>>;

const INTENT_PROFILES: Record<TaskIntentType, Weights> = {
  bug_fix:    { relevance: 0.30, dependency: 0.20, recency: 0.10, errorSignal: 0.40 },
  feature:    { relevance: 0.45, dependency: 0.35, recency: 0.10, errorSignal: 0.10 },
  refactor:   { relevance: 0.25, dependency: 0.45, recency: 0.15, errorSignal: 0.15 },
  understand: { relevance: 0.55, dependency: 0.25, recency: 0.10, errorSignal: 0.10 },
};

export class Scorer {
  score(
    candidates: ContextCandidate[],
    intent: TaskIntent,
    userWeights: Partial<Weights> | undefined,
    files?: Map<string, { lastModified: number }>
  ): ContextCandidate[] {
    const base = INTENT_PROFILES[intent.type];
    const weights: Weights = { ...base, ...userWeights };

    const scored = candidates.map((c) => {
      let recency = c.scores.recency;
      const fileNode = files?.get(c.path);
      if (fileNode) {
        const ageDays = (Date.now() - fileNode.lastModified) / (1000 * 60 * 60 * 24);
        recency = Math.exp(-Math.LN2 * ageDays / AGE_HALF_LIFE_DAYS);
      }
      const s = { ...c.scores, recency };
      const finalScore =
        weights.relevance   * s.relevance   +
        weights.dependency  * s.dependency  +
        weights.recency     * s.recency     +
        weights.errorSignal * s.errorSignal;
      return { ...c, scores: s, finalScore };
    });

    // Sort: pinned first, then by finalScore
    scored.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.finalScore - a.finalScore;
    });

    // Apply diversity reranking (MMR) to prevent single-cluster dominance
    const ranker = new DiversityRanker();
    return ranker.rerank(scored);
  }
}
