import { ContextCandidate, FocalConfig, TaskIntent, TaskIntentType } from '../types';

const AGE_HALF_LIFE_DAYS = 14;

type Weights = Required<NonNullable<FocalConfig['weights']>>;

/** Intent-driven weight profiles — different tasks value different signals differently. */
const INTENT_PROFILES: Record<TaskIntentType, Weights> = {
  // Bug fixing: error signal dominates (stack trace sites, failed tests, past failures)
  bug_fix: {
    relevance:   0.30,
    dependency:  0.20,
    recency:     0.10,
    errorSignal: 0.40,
  },
  // Feature building: dependency graph matters most (understand the existing shape)
  feature: {
    relevance:   0.45,
    dependency:  0.35,
    recency:     0.10,
    errorSignal: 0.10,
  },
  // Refactoring: call graph depth critical — find everything that will break
  refactor: {
    relevance:   0.25,
    dependency:  0.45,
    recency:     0.15,
    errorSignal: 0.15,
  },
  // Understanding: pure relevance — bring the most explanatory code
  understand: {
    relevance:   0.55,
    dependency:  0.25,
    recency:     0.10,
    errorSignal: 0.10,
  },
};

export class Scorer {
  score(
    candidates: ContextCandidate[],
    intent: TaskIntent,
    userWeights: Partial<Weights> | undefined,
    files?: Map<string, { lastModified: number }>
  ): ContextCandidate[] {
    // Merge: user weights override intent profile, which overrides defaults
    const base = INTENT_PROFILES[intent.type];
    const weights: Weights = { ...base, ...userWeights };

    const scored = candidates.map((c) => {
      // Recency: exponential decay with 14-day half-life
      let recency = c.scores.recency;
      const fileNode = files?.get(c.path);
      if (fileNode) {
        const ageDays = (Date.now() - fileNode.lastModified) / (1000 * 60 * 60 * 24);
        recency = Math.exp(-Math.LN2 * ageDays / AGE_HALF_LIFE_DAYS);
      }

      const scores = { ...c.scores, recency };

      const finalScore =
        weights.relevance   * scores.relevance   +
        weights.dependency  * scores.dependency  +
        weights.recency     * scores.recency     +
        weights.errorSignal * scores.errorSignal;

      return { ...c, scores, finalScore };
    });

    // Pinned candidates always sort first, then by finalScore descending
    return scored.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.finalScore - a.finalScore;
    });
  }
}
