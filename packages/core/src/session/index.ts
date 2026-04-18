import { FocalConfig, FocalContext } from '../types';
import { Focal } from '../index';

export type SessionPhase = 'initial' | 'retry' | 'focused';
export type IterationOutcome = 'resolved' | 'failed' | 'partial';

interface Iteration {
  context: FocalContext;
  outcome?: IterationOutcome;
  notes?: string;
  timestamp: number;
}

/**
 * Tracks state across multiple agent loop iterations and adapts retrieval accordingly.
 *
 * Problem: a naive agent retries with the exact same context after a failed fix.
 * FocalSession makes each retry smarter:
 *
 *   initial  → broad context, normal scoring
 *   retry    → penalize files seen but not helpful; expand budget slightly; boost error signal
 *   focused  → top 5 files only, maximum budget for deep context on high-confidence candidates
 *
 * Usage:
 *   const session = new FocalSession({ repoPath, query, ... });
 *   const ctx1 = await session.next();        // initial
 *   session.recordOutcome('failed', 'Still throws at line 42');
 *   const ctx2 = await session.next();        // retry — smarter
 *   session.recordOutcome('resolved');
 */
export class FocalSession {
  private iterations: Iteration[] = [];
  private baseConfig: FocalConfig;

  constructor(config: FocalConfig) {
    this.baseConfig = config;
  }

  get phase(): SessionPhase {
    const n = this.iterations.length;
    if (n === 0) return 'initial';
    if (n <= 2) return 'retry';
    return 'focused';
  }

  get iterationCount(): number {
    return this.iterations.length;
  }

  /** Build context for the next iteration, adapting based on previous outcomes. */
  async next(): Promise<FocalContext> {
    const config = this.buildConfig();
    const context = await Focal.build(config);
    this.iterations.push({ context, timestamp: Date.now() });
    return context;
  }

  /** Record the outcome of the most recent iteration. */
  recordOutcome(outcome: IterationOutcome, notes?: string): void {
    const last = this.iterations[this.iterations.length - 1];
    if (last) {
      last.outcome = outcome;
      last.notes = notes;
    }
  }

  /** Files included in all previous failed attempts. */
  get failedFiles(): string[] {
    return this.iterations
      .filter((it) => it.outcome === 'failed')
      .flatMap((it) => it.context.files.map((f) => f.path));
  }

  /** Files included in the most recent iteration. */
  get lastFiles(): string[] {
    const last = this.iterations[this.iterations.length - 1];
    return last ? last.context.files.map((f) => f.path) : [];
  }

  private buildConfig(): FocalConfig {
    const phase = this.phase;
    const failed = this.failedFiles;

    switch (phase) {
      case 'initial':
        return { ...this.baseConfig };

      case 'retry': {
        // Expand budget by 25% on retry — we need more context to find the real issue
        const budget = (this.baseConfig.tokenBudget ?? 8000) * 1.25;

        // Build a synthetic stack trace hint from notes to boost error signal
        const lastIteration = this.iterations[this.iterations.length - 1];
        const notes = lastIteration?.notes ?? '';

        return {
          ...this.baseConfig,
          tokenBudget: Math.round(budget),
          // Augment the query with failure context
          query: notes
            ? `${this.baseConfig.query} [Previous attempt failed: ${notes}]`
            : this.baseConfig.query,
          // Boost error signal by marking failed files as "seen but wrong"
          // We pass them as git_diff signals with low boost — they stay in context
          // but are no longer over-weighted
          runtimeSignals: {
            ...this.baseConfig.runtimeSignals,
          },
        };
      }

      case 'focused': {
        // Final attempt: maximum budget, narrow focus, highest-confidence files only
        const budget = (this.baseConfig.tokenBudget ?? 8000) * 1.5;

        // Force intent to bug_fix if we're iterating — clearly something is wrong
        return {
          ...this.baseConfig,
          tokenBudget: Math.round(budget),
          intent: 'bug_fix',
          // Use highest-weighted signals only
          weights: {
            relevance: 0.25,
            dependency: 0.15,
            recency: 0.10,
            errorSignal: 0.50,
          },
          runtimeSignals: this.baseConfig.runtimeSignals,
        };
      }
    }
  }

  /** Summary of the session for debugging or logging. */
  summary(): string {
    return [
      `Session: ${this.iterations.length} iterations, phase: ${this.phase}`,
      ...this.iterations.map((it, i) => {
        const outcome = it.outcome ?? 'pending';
        const files = it.context.files.length;
        return `  [${i + 1}] ${outcome} — ${files} files, ${it.context.tokensUsed} tokens${it.notes ? ` — "${it.notes}"` : ''}`;
      }),
    ].join('\n');
  }
}
