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

  // Collect import lines
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

  // Collect function/class signatures (first line of each)
  for (const fn of fileNode.functions) {
    const sigLine = lines[fn.startLine - 1];
    if (sigLine) signatureLines.push(sigLine);
  }
  for (const cls of fileNode.classes) {
    // Find the class declaration line
    const clsLine = lines.findIndex((l) =>
      l.includes(`class ${cls.name}`)
    );
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

export class ContextCompiler {
  async compile(
    candidates: ContextCandidate[],
    config: Required<Pick<FocalConfig, 'query' | 'tokenBudget' | 'repoPath'>> & {
      fileNodes?: Map<string, FileNode>;
    }
  ): Promise<FocalContext> {
    let remainingBudget = config.tokenBudget;
    const includedFiles: IncludedFile[] = [];
    let truncated = false;

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
        // Include full file
        includedFiles.push({
          path: candidate.path,
          content,
          reason: this.buildReason(candidate),
          score: candidate.finalScore,
          resolution: 'full',
        });
        remainingBudget -= fullTokens;
      } else if (remainingBudget >= config.tokenBudget * 0.4) {
        // Include signatures only
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
      .map((f) => path.basename(f.path))
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
      buildTimeMs: 0, // set by caller
    };
  }

  private buildReason(candidate: ContextCandidate): string {
    const reasons: string[] = [];
    if (candidate.scores.relevance > 0.3) reasons.push('keyword match');
    if (candidate.scores.dependency > 0.3) reasons.push('import dependency');
    if (candidate.scores.errorSignal > 0.3) reasons.push('related past changes');
    if (candidate.scores.recency > 0.7) reasons.push('recently modified');
    return reasons.length > 0 ? reasons.join(', ') : 'graph traversal';
  }
}
