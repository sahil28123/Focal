import { ContextCandidate, FocalConfig } from '../types';

const AGE_HALF_LIFE_DAYS = 14;

export class Scorer {
  score(
    candidates: ContextCandidate[],
    weights: Required<NonNullable<FocalConfig['weights']>>,
    files?: Map<string, { lastModified: number }>
  ): ContextCandidate[] {
    const scored = candidates.map((c) => {
      // Compute recency score from file metadata if available
      let recency = c.scores.recency;
      if (files) {
        const fileNode = files.get(c.path);
        if (fileNode) {
          const ageInDays = (Date.now() - fileNode.lastModified) / (1000 * 60 * 60 * 24);
          recency = Math.exp(-Math.LN2 * ageInDays / AGE_HALF_LIFE_DAYS);
        }
      }

      const scores = { ...c.scores, recency };

      const finalScore =
        weights.relevance * scores.relevance +
        weights.dependency * scores.dependency +
        weights.recency * scores.recency +
        weights.errorSignal * scores.errorSignal;

      return { ...c, scores, finalScore };
    });

    return scored.sort((a, b) => b.finalScore - a.finalScore);
  }
}
