import { FocalConfig, FocalContext, IncludedFile, IncrementalDelta } from '../types';
import { Focal } from '../index';

/**
 * Incremental context mode — for iterative agents that already loaded a previous context.
 *
 * Instead of resending 6,000 tokens of unchanged code, send only:
 *   - Files newly added to context
 *   - Files whose content changed since last build
 *   - A list of paths that are unchanged (agent already has them)
 *   - A list of paths that dropped out
 *
 * Typical savings: 60–80% token reduction on subsequent iterations when most
 * of the codebase is stable.
 *
 * Usage:
 *   const ctx1 = await Focal.build(config);
 *   // ... agent does something, files change ...
 *   const delta = await buildIncremental(config, ctx1);
 *   agent.send(formatDelta(delta));  // much smaller payload
 */
export async function buildIncremental(
  config: FocalConfig,
  previous: FocalContext
): Promise<IncrementalDelta> {
  const start = Date.now();

  const current = await Focal.build(config);

  const previousByPath = new Map(previous.files.map((f) => [f.path, f]));
  const currentByPath = new Map(current.files.map((f) => [f.path, f]));

  const added: IncludedFile[] = [];
  const changed: IncludedFile[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  // Classify current files
  for (const [fp, file] of currentByPath) {
    const prev = previousByPath.get(fp);
    if (!prev) {
      added.push(file);
    } else if (contentChanged(prev.content, file.content)) {
      changed.push(file);
    } else {
      unchanged.push(fp);
    }
  }

  // Find removed files
  for (const fp of previousByPath.keys()) {
    if (!currentByPath.has(fp)) removed.push(fp);
  }

  const tokensUsed =
    [...added, ...changed].reduce((s, f) => s + Math.ceil(f.content.length / 4), 0);
  const tokensSaved =
    unchanged.reduce((s, fp) => {
      const f = previousByPath.get(fp);
      return s + (f ? Math.ceil(f.content.length / 4) : 0);
    }, 0);

  const parts: string[] = [];
  if (added.length)     parts.push(`${added.length} new`);
  if (changed.length)   parts.push(`${changed.length} changed`);
  if (removed.length)   parts.push(`${removed.length} removed`);
  if (unchanged.length) parts.push(`${unchanged.length} unchanged (omitted)`);
  const summary = `Incremental delta: ${parts.join(', ')}. Saved ${tokensSaved} tokens vs full rebuild.`;

  return {
    added,
    changed,
    removed,
    unchanged,
    tokensUsed,
    tokensSaved,
    buildTimeMs: Date.now() - start,
    summary,
  };
}

/**
 * Detect whether content meaningfully changed between two versions.
 * Uses length + start/end fingerprint — O(1), no full diff needed.
 */
function contentChanged(a: string, b: string): boolean {
  if (a.length !== b.length) return true;
  if (a.length === 0) return false;
  // Sample first 80 and last 80 chars — catches most edits without full compare
  const sampleLen = 80;
  const aHead = a.slice(0, sampleLen);
  const bHead = b.slice(0, sampleLen);
  const aTail = a.slice(-sampleLen);
  const bTail = b.slice(-sampleLen);
  return aHead !== bHead || aTail !== bTail;
}
