import { ContextCandidate, ContextConfidence, FocalContext, PinnedNode } from '../types';
import { DiversityRanker } from '../ranking/diversity';

/**
 * Estimates how confident Focal is that the selected context is correct.
 *
 * This metadata is useful for agents and CI pipelines:
 * - "high" → proceed with the fix
 * - "medium" → proceed but verify assumptions
 * - "low" → query is vague; consider asking for clarification or expanding budget
 *
 * No external calls — pure signal analysis over already-computed data.
 */
export class ConfidenceEstimator {
  estimate(
    context: Omit<FocalContext, 'confidence'>,
    ranked: ContextCandidate[],
    pinnedNodes: PinnedNode[],
    memoryPatternHits: number
  ): ContextConfidence {
    const warnings: string[] = [];

    // 1. Signal coverage: fraction of pinned files actually included in context
    const pinnedPaths = new Set(pinnedNodes.map((p) => p.filePath));
    const includedPaths = new Set(context.files.map((f) => f.path));
    const signalCoverage = pinnedPaths.size > 0
      ? [...pinnedPaths].filter((p) => includedPaths.has(p)).length / pinnedPaths.size
      : 0.5; // neutral when no runtime signals

    // 2. Top candidate score
    const topCandidateScore = ranked.length > 0 ? ranked[0].finalScore : 0;
    if (topCandidateScore < 0.25) {
      warnings.push(`Top candidate score is ${topCandidateScore.toFixed(2)} — query may be too vague or codebase too large`);
    }

    // 3. Memory pattern hits (normalized: 3+ hits = full score)
    const memoryScore = Math.min(1, memoryPatternHits / 3);

    // 4. Budget utilization
    const budgetUtilization = context.tokensUsed / context.tokenBudget;
    if (budgetUtilization < 0.3 && context.files.length < 3) {
      warnings.push(`Only ${context.files.length} files found — query may not match the codebase`);
    }
    if (context.truncated) {
      warnings.push(`Context was truncated — ${context.graph.reachableButExcluded} relevant files excluded by budget`);
    }

    // 5. Diversity
    const diversityScore = DiversityRanker.diversityScore(context.files.map((f) => f.path));

    // Weighted overall score
    const overall =
      signalCoverage   * 0.30 +
      topCandidateScore * 0.30 +
      memoryScore       * 0.15 +
      Math.min(budgetUtilization, 1) * 0.15 +
      diversityScore    * 0.10;

    const verdict: ContextConfidence['verdict'] =
      overall >= 0.65 ? 'high' :
      overall >= 0.40 ? 'medium' : 'low';

    if (verdict === 'low') {
      warnings.push(`Overall confidence is low (${overall.toFixed(2)}) — consider providing a stack trace or more specific query`);
    }

    return {
      overall,
      verdict,
      breakdown: {
        signalCoverage,
        topCandidateScore,
        memoryPatternHits: memoryScore,
        budgetUtilization,
        diversityScore,
      },
      warnings,
    };
  }
}
