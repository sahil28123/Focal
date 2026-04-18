import * as fs from 'fs';
import * as path from 'path';
import { ContextCandidate, FocalConfig, FocalContext, IncludedFile, FileNode } from '../types';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractSignatures(fileContent: string, fileNode: FileNode): string {
  const lines = fileContent.split('\n');
  const importLines: string[] = [];
  const signatureLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('from ') ||
      trimmed.startsWith('require(')
    ) {
      importLines.push(line);
    }
  }

  for (const fn of fileNode.functions) {
    const sigLine = lines[fn.startLine - 1];
    if (sigLine) signatureLines.push(sigLine);
  }
  for (const cls of fileNode.classes) {
    const clsLine = lines.findIndex((l) => l.includes(`class ${cls.name}`));
    if (clsLine >= 0) signatureLines.push(lines[clsLine] + ' { ... }');
  }

  const n = fileNode.functions.length + fileNode.classes.length;
  return [
    ...importLines,
    '',
    `// ... ${n} declarations — signatures only ...`,
    ...signatureLines,
  ].join('\n');
}

type CompileConfig = Required<Pick<FocalConfig, 'query' | 'tokenBudget' | 'repoPath'>> & {
  fileNodes?: Map<string, FileNode>;
  summarize?: FocalConfig['summarize'];
};

export class ContextCompiler {
  async compile(
    candidates: ContextCandidate[],
    config: CompileConfig
  ): Promise<FocalContext> {
    let remainingBudget = config.tokenBudget;
    const includedFiles: IncludedFile[] = [];
    let truncated = false;

    // Use first repo path for relative display if multi-repo
    const baseRepo = Array.isArray(config.repoPath)
      ? config.repoPath[0]
      : config.repoPath;

    for (const candidate of candidates) {
      if (remainingBudget <= 0) {
        truncated = true;
        break;
      }

      let content: string;
      try {
        content = await fs.promises.readFile(candidate.path, 'utf8');
      } catch {
        continue;
      }

      const fullTokens = estimateTokens(content);

      if (fullTokens <= remainingBudget) {
        // Full file fits
        includedFiles.push({
          path: candidate.path,
          content,
          reason: this.buildReason(candidate),
          score: candidate.finalScore,
          resolution: 'full',
        });
        remainingBudget -= fullTokens;
      } else if (config.summarize && remainingBudget >= config.tokenBudget * 0.15) {
        // LLM summary — user-provided callback, no Focal dependency on any LLM
        try {
          const summaryText = await config.summarize(content, config.query, candidate.path);
          const summaryTokens = estimateTokens(summaryText);
          if (summaryTokens <= remainingBudget) {
            includedFiles.push({
              path: candidate.path,
              content: summaryText,
              reason: this.buildReason(candidate) + ' (LLM summary — full file exceeds budget)',
              score: candidate.finalScore,
              resolution: 'summary',
            });
            remainingBudget -= summaryTokens;
          }
        } catch {
          // Fall through to signature-only if summarize throws
          this.trySignatureOnly(candidate, content, config, includedFiles, remainingBudget);
        }
      } else if (remainingBudget >= config.tokenBudget * 0.4) {
        // Signature-only fallback
        const fileNode = config.fileNodes?.get(candidate.path);
        if (fileNode) {
          const sigContent = extractSignatures(content, fileNode);
          const sigTokens = estimateTokens(sigContent);
          if (sigTokens <= remainingBudget) {
            includedFiles.push({
              path: candidate.path,
              content: sigContent,
              reason: this.buildReason(candidate) + ' (signatures only — full file exceeds budget)',
              score: candidate.finalScore,
              resolution: 'signature-only',
            });
            remainingBudget -= sigTokens;
          }
        }
      } else {
        truncated = true;
        break;
      }
    }

    const tokensUsed = config.tokenBudget - remainingBudget;
    const top3 = includedFiles
      .slice(0, 3)
      .map((f) => path.relative(baseRepo, f.path))
      .join(', ');

    const summary =
      `Included ${includedFiles.length} files (${tokensUsed} tokens). ` +
      (top3 ? `Top files: ${top3}. ` : '') +
      `Focused on: ${config.query}.`;

    return {
      query: config.query,
      tokenBudget: config.tokenBudget,
      tokensUsed,
      files: includedFiles,
      summary,
      truncated,
      buildTimeMs: 0,
    };
  }

  private trySignatureOnly(
    candidate: ContextCandidate,
    content: string,
    config: CompileConfig,
    includedFiles: IncludedFile[],
    remainingBudget: number
  ): void {
    const fileNode = config.fileNodes?.get(candidate.path);
    if (!fileNode) return;
    const sigContent = extractSignatures(content, fileNode);
    const sigTokens = estimateTokens(sigContent);
    if (sigTokens <= remainingBudget) {
      includedFiles.push({
        path: candidate.path,
        content: sigContent,
        reason: this.buildReason(candidate) + ' (signatures only — full file exceeds budget)',
        score: candidate.finalScore,
        resolution: 'signature-only',
      });
    }
  }

  private buildReason(candidate: ContextCandidate): string {
    const reasons: string[] = [];
    if (candidate.scores.relevance > 0.3) reasons.push('keyword/semantic match');
    if (candidate.scores.dependency > 0.3) reasons.push('import dependency');
    if (candidate.scores.errorSignal > 0.3) reasons.push('related past changes');
    if (candidate.scores.recency > 0.7) reasons.push('recently modified');
    return reasons.length > 0 ? reasons.join(', ') : 'graph traversal';
  }
}
