import * as fs from 'fs';
import * as path from 'path';
import {
  ContextCandidate, FocalConfig, FocalContext, IncludedFile, FileNode, TaskIntent, PinnedNode,
} from '../types';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Resolution value multipliers — how much information each resolution preserves. */
const RESOLUTION_VALUE: Record<string, number> = {
  full:             1.0,
  snippet:          0.92,  // function-level: high precision, slight context loss
  summary:          0.72,  // LLM summary: good but lossy
  'signature-only': 0.55,  // structural skeleton only
};

function extractSignatures(fileContent: string, fileNode: FileNode): string {
  const lines = fileContent.split('\n');
  const importLines: string[] = [];
  const sigLines: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('import ') || t.startsWith('from ') || t.startsWith('require(')) {
      importLines.push(line);
    }
  }
  for (const fn of fileNode.functions) {
    const sig = lines[fn.startLine - 1];
    if (sig) sigLines.push(sig.trimEnd());
  }
  for (const cls of fileNode.classes) {
    const idx = lines.findIndex((l) => l.includes(`class ${cls.name}`));
    if (idx >= 0) sigLines.push(lines[idx].trimEnd() + ' { ... }');
  }

  const n = fileNode.functions.length + fileNode.classes.length;
  return [...importLines, '', `// ... ${n} declarations — signatures only ...`, ...sigLines].join('\n');
}

function extractSnippet(
  fileContent: string,
  startLine: number,
  endLine: number,
  context = 2
): string {
  const lines = fileContent.split('\n');
  const from = Math.max(0, startLine - 1 - context);
  const to = Math.min(lines.length - 1, endLine - 1 + context);
  return lines.slice(from, to + 1).join('\n');
}

function getRepoRoot(filePath: string, repoPaths: string[]): string {
  for (const rp of repoPaths) {
    if (filePath.startsWith(rp)) return rp;
  }
  return repoPaths[0] ?? path.dirname(filePath);
}

interface AllocationVariant {
  candidate: ContextCandidate;
  resolution: IncludedFile['resolution'];
  tokens: number;
  value: number;
  vpt: number;  // value per token
}

type CompileConfig = {
  query: string;
  tokenBudget: number;
  repoPath: string | string[];
  intent: TaskIntent;
  fileNodes?: Map<string, FileNode>;
  pinnedNodes?: PinnedNode[];
  summarize?: FocalConfig['summarize'];
  totalCandidates: number;
};

export class ContextCompiler {
  async compile(
    ranked: ContextCandidate[],
    config: CompileConfig
  ): Promise<FocalContext> {
    const repoPaths = Array.isArray(config.repoPath) ? config.repoPath : [config.repoPath];
    const budget = config.tokenBudget;

    // Read all candidate file contents upfront (parallel)
    const contentMap = new Map<string, string>();
    await Promise.all(
      [...new Set(ranked.map((c) => c.path))].map(async (fp) => {
        try { contentMap.set(fp, await fs.promises.readFile(fp, 'utf8')); } catch { /* skip */ }
      })
    );

    // ── Build allocation variants ─────────────────────────────────────────────
    // For each candidate + each valid resolution, compute (tokens, value, vpt).
    // We'll sort all variants by vpt and fill greedily — this is a 0-1 knapsack
    // approximation that's within ~5% of optimal and runs in O(n log n).
    const variants: AllocationVariant[] = [];

    for (const c of ranked) {
      const content = contentMap.get(c.path);
      if (!content) continue;

      if (c.type === 'function' && c.startLine !== undefined && c.endLine !== undefined) {
        // Function-level: only snippet resolution
        const snippet = extractSnippet(content, c.startLine, c.endLine);
        const tokens = estimateTokens(snippet);
        const value = c.finalScore * RESOLUTION_VALUE['snippet'];
        variants.push({ candidate: c, resolution: 'snippet', tokens, value, vpt: value / Math.max(tokens, 1) });
      } else {
        // File-level: full, signature-only, optionally summary
        const fileNode = config.fileNodes?.get(c.path);
        const fullTokens = estimateTokens(content);

        // Full
        variants.push({
          candidate: c,
          resolution: 'full',
          tokens: fullTokens,
          value: c.finalScore * RESOLUTION_VALUE['full'],
          vpt: (c.finalScore * RESOLUTION_VALUE['full']) / Math.max(fullTokens, 1),
        });

        // Signature-only
        if (fileNode) {
          const sigContent = extractSignatures(content, fileNode);
          const sigTokens = estimateTokens(sigContent);
          variants.push({
            candidate: c,
            resolution: 'signature-only',
            tokens: sigTokens,
            value: c.finalScore * RESOLUTION_VALUE['signature-only'],
            vpt: (c.finalScore * RESOLUTION_VALUE['signature-only']) / Math.max(sigTokens, 1),
          });
        }

        // LLM summary (will be fetched lazily during allocation if selected)
        if (config.summarize) {
          // Estimate summary tokens as ~15% of full file
          const estSumTokens = Math.ceil(fullTokens * 0.15);
          const summaryValue = c.finalScore * RESOLUTION_VALUE['summary'];
          variants.push({
            candidate: c,
            resolution: 'summary',
            tokens: estSumTokens,
            value: summaryValue,
            vpt: summaryValue / Math.max(estSumTokens, 1),
          });
        }
      }
    }

    // ── Greedy knapsack by VPT ────────────────────────────────────────────────
    // Pinned candidates are always allocated first regardless of VPT.
    variants.sort((a, b) => {
      const aPinned = a.candidate.pinned ? 1 : 0;
      const bPinned = b.candidate.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return b.vpt - a.vpt;
    });

    const includedFiles: IncludedFile[] = [];
    const allocatedPaths = new Set<string>();
    let remainingBudget = budget;
    let truncated = false;

    for (const variant of variants) {
      const fp = variant.candidate.path;
      if (allocatedPaths.has(fp)) continue; // each file/function allocated at most once
      if (variant.tokens > remainingBudget) {
        if (!variant.candidate.pinned) continue; // skip non-pinned that don't fit
        truncated = true; // pinned files forced in even if over budget
      }

      let content = contentMap.get(fp) ?? '';
      let resolution = variant.resolution;

      if (resolution === 'snippet' && variant.candidate.startLine !== undefined) {
        content = extractSnippet(content, variant.candidate.startLine, variant.candidate.endLine!);
      } else if (resolution === 'signature-only') {
        const fileNode = config.fileNodes?.get(fp);
        if (fileNode) content = extractSignatures(content, fileNode);
      } else if (resolution === 'summary' && config.summarize) {
        try {
          content = await config.summarize(content, config.query, fp);
        } catch {
          // Fall back to signatures if summarize throws
          const fileNode = config.fileNodes?.get(fp);
          if (fileNode) {
            content = extractSignatures(content, fileNode);
            resolution = 'signature-only';
          }
        }
      }

      const actualTokens = estimateTokens(content);

      // Build runtime context metadata
      const pinNode = (config.pinnedNodes ?? []).find((p) => p.filePath === fp);
      const runtimeContext = pinNode
        ? {
            appearsInStackTrace: pinNode.source === 'stack_trace',
            failingTests: pinNode.source === 'test_failure' ? [fp] : [],
          }
        : undefined;

      // Related symbols: exports from the file not already captured as the snippet
      const fileNode = config.fileNodes?.get(fp);
      const relatedSymbols = fileNode
        ? [
            ...fileNode.functions.filter((f) => f.isExported && f.name !== variant.candidate.functionName).map((f) => f.name),
            ...fileNode.classes.filter((c) => c.isExported).map((c) => c.name),
          ].slice(0, 8)
        : [];

      includedFiles.push({
        path: fp,
        repoRoot: getRepoRoot(fp, repoPaths),
        content,
        reason: this.buildReason(variant.candidate, resolution),
        score: variant.candidate.finalScore,
        resolution,
        snippet:
          resolution === 'snippet' && variant.candidate.functionName
            ? {
                startLine: variant.candidate.startLine!,
                endLine: variant.candidate.endLine!,
                symbol: variant.candidate.functionName,
              }
            : undefined,
        runtimeContext,
        relatedSymbols,
      });

      allocatedPaths.add(fp);
      remainingBudget -= actualTokens;

      if (remainingBudget <= 0 && !truncated) truncated = true;
    }

    const tokensUsed = budget - remainingBudget;
    const top3 = includedFiles
      .slice(0, 3)
      .map((f) => path.relative(getRepoRoot(f.path, repoPaths), f.path))
      .join(', ');

    const reachableButExcluded = config.totalCandidates - includedFiles.length;

    const summary =
      `Included ${includedFiles.length} files (${tokensUsed} tokens, ${Math.round((tokensUsed / budget) * 100)}% of budget). ` +
      (top3 ? `Top files: ${top3}. ` : '') +
      `Intent: ${config.intent.type}. Focused on: ${config.query}.`;

    return {
      query: config.query,
      intent: config.intent,
      tokenBudget: budget,
      tokensUsed,
      files: includedFiles,
      summary,
      truncated,
      buildTimeMs: 0,
      graph: {
        seedFiles: [],  // set by caller
        reachableButExcluded,
      },
      pinnedFiles: (config.pinnedNodes ?? []).map((p) => p.filePath),
    };
  }

  private buildReason(c: ContextCandidate, resolution: string): string {
    const parts: string[] = [];
    if (c.pinned)                        parts.push('runtime signal (pinned)');
    if (c.scores.relevance > 0.35)       parts.push('BM25/semantic match');
    if (c.scores.errorSignal > 0.3)      parts.push('related past failures');
    if (c.scores.dependency > 0.35)      parts.push('import dependency');
    if (c.scores.recency > 0.7)          parts.push('recently modified');
    if (c.type === 'function')           parts.push(`function-level snippet: ${c.functionName}`);
    if (resolution === 'signature-only') parts.push('signatures only — full file exceeds budget');
    if (resolution === 'summary')        parts.push('LLM summary — full file exceeds budget');
    return parts.length > 0 ? parts.join(', ') : 'graph traversal';
  }
}
