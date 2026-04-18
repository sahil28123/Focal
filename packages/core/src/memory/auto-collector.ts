import * as path from 'path';
import { FocalContext } from '../types';
import { MemoryStore } from './store';

const MIN_SCORE_THRESHOLD = 0.45;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|go|java|rb|rs|cs)$/;

/**
 * Automatically records Focal builds into the memory store — no manual input required.
 *
 * Usage:
 *   const collector = new MemoryAutoCollector(store);
 *   const id = await collector.recordBuild(context);
 *   // later, when the agent reports success or failure:
 *   await collector.recordOutcome(id, 'failure');
 */
export class MemoryAutoCollector {
  constructor(private store: MemoryStore) {}

  /**
   * Record which files were surfaced for a build.
   * Only records files whose score meets the threshold — avoids polluting
   * memory with low-signal noise from graph traversal padding.
   * Returns the new record ID (pass to recordOutcome later).
   */
  async recordBuild(context: FocalContext): Promise<string | null> {
    const highScoreFiles = context.files
      .filter((f) => f.score >= MIN_SCORE_THRESHOLD)
      .map((f) => f.path);

    if (highScoreFiles.length === 0) return null;

    const record = await this.store.add({
      type: 'change',
      files: highScoreFiles,
      description: context.query,
      outcome: 'unknown',
    });

    return record.id;
  }

  /**
   * Mark the outcome of a build after the agent finishes.
   * Files from a 'failure' build get errorSignal boost in future queries.
   */
  async recordOutcome(id: string, outcome: 'success' | 'failure'): Promise<void> {
    await this.store.markOutcome(id, outcome);
  }

  /**
   * Ingest a git diff string and record the changed files.
   * Accepts output from `git diff --name-only` or `git diff --stat`.
   */
  async ingestDiff(diff: string, description: string, repoPath: string): Promise<void> {
    const files = diff
      .split('\n')
      .map((l) => l.trim().split(/\s+\|\s+/)[0].trim())
      .filter((f) => f && SOURCE_EXT.test(f))
      .map((f) => (path.isAbsolute(f) ? f : path.resolve(repoPath, f)));

    if (files.length === 0) return;

    await this.store.add({
      type: 'change',
      files,
      description,
      outcome: 'unknown',
    });
  }
}
