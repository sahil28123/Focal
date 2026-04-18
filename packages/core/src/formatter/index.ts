import * as path from 'path';
import { FocalContext, IncludedFile } from '../types';

export type FormatStyle = 'xml-tags' | 'markdown' | 'plain';

export interface FormatOptions {
  style?: FormatStyle;
  includeReasons?: boolean;
  includeScores?: boolean;
  includePreamble?: boolean;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  style: 'xml-tags',
  includeReasons: true,
  includeScores: false,
  includePreamble: true,
};

/**
 * Formats a FocalContext into an optimized prompt string.
 *
 * Recommended style per model:
 *   - Claude: 'xml-tags'  (Claude is trained to reason about XML tag boundaries)
 *   - GPT-4:  'markdown'
 *   - Others: 'plain'
 */
export class FocalFormatter {
  toPrompt(context: FocalContext, options?: FormatOptions): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const parts: string[] = [];

    if (opts.includePreamble) {
      parts.push(this.toPreamble(context));
      parts.push('');
    }

    switch (opts.style) {
      case 'xml-tags':  parts.push(this.formatXml(context, opts));   break;
      case 'markdown':  parts.push(this.formatMarkdown(context, opts)); break;
      default:          parts.push(this.formatPlain(context, opts));  break;
    }

    return parts.join('\n');
  }

  /**
   * Returns a concise preamble explaining what was included and why.
   * Paste this into the system prompt or before the context block.
   */
  toPreamble(context: FocalContext): string {
    const lines: string[] = [
      `<focal_preamble>`,
      `Query: ${context.query}`,
      `Intent: ${context.intent.type} (confidence: ${Math.round(context.intent.confidence * 100)}%)`,
      `Context: ${context.files.length} files, ${context.tokensUsed}/${context.tokenBudget} tokens used`,
    ];

    if (context.pinnedFiles.length > 0) {
      lines.push(`Pinned (from runtime signals): ${context.pinnedFiles.map((p) => path.basename(p)).join(', ')}`);
    }
    if (context.graph.reachableButExcluded > 0) {
      lines.push(`${context.graph.reachableButExcluded} additional reachable files excluded by token budget`);
    }
    if (context.truncated) {
      lines.push(`Note: context was truncated — some relevant files were excluded`);
    }

    lines.push(`</focal_preamble>`);
    return lines.join('\n');
  }

  // ── XML tags (Claude-optimized) ─────────────────────────────────────────────

  private formatXml(context: FocalContext, opts: Required<FormatOptions>): string {
    const attrs = [
      `intent="${context.intent.type}"`,
      `query="${escapeAttr(context.query)}"`,
      opts.includeScores ? `tokens_used="${context.tokensUsed}"` : '',
    ].filter(Boolean).join(' ');

    const fileParts = context.files.map((f) => this.fileToXml(f, opts));

    return [
      `<focal_context ${attrs}>`,
      ...fileParts,
      `</focal_context>`,
    ].join('\n');
  }

  private fileToXml(f: IncludedFile, opts: Required<FormatOptions>): string {
    const relPath = path.relative(f.repoRoot, f.path);
    const attrs = [
      `path="${escapeAttr(relPath)}"`,
      `resolution="${f.resolution}"`,
      opts.includeScores ? `score="${f.score.toFixed(2)}"` : '',
      f.snippet ? `symbol="${f.snippet.symbol}" lines="${f.snippet.startLine}-${f.snippet.endLine}"` : '',
      f.runtimeContext?.appearsInStackTrace ? `pinned="stack_trace"` : '',
    ].filter(Boolean).join(' ');

    const parts: string[] = [`  <file ${attrs}>`];

    if (opts.includeReasons) {
      parts.push(`    <!-- ${f.reason} -->`);
    }
    if (f.relatedSymbols.length > 0) {
      parts.push(`    <!-- also exports: ${f.relatedSymbols.join(', ')} -->`);
    }

    parts.push(f.content);
    parts.push(`  </file>`);
    return parts.join('\n');
  }

  // ── Markdown ─────────────────────────────────────────────────────────────────

  private formatMarkdown(context: FocalContext, opts: Required<FormatOptions>): string {
    const parts: string[] = [];

    for (const f of context.files) {
      const relPath = path.relative(f.repoRoot, f.path);
      const badge = f.runtimeContext?.appearsInStackTrace ? ' 🔴' : '';
      const scorePart = opts.includeScores ? ` (score: ${f.score.toFixed(2)})` : '';
      const snipPart = f.snippet ? ` — \`${f.snippet.symbol}\` lines ${f.snippet.startLine}–${f.snippet.endLine}` : '';

      parts.push(`### \`${relPath}\`${badge}${scorePart}${snipPart}`);

      if (opts.includeReasons) {
        parts.push(`> ${f.reason}`);
      }
      if (f.relatedSymbols.length > 0) {
        parts.push(`> Also exports: \`${f.relatedSymbols.join('`, `')}\``);
      }

      const lang = langFromPath(f.path);
      parts.push(`\`\`\`${lang}`, f.content, '```', '');
    }

    return parts.join('\n');
  }

  // ── Plain ─────────────────────────────────────────────────────────────────────

  private formatPlain(context: FocalContext, opts: Required<FormatOptions>): string {
    const parts: string[] = [];

    for (const f of context.files) {
      const relPath = path.relative(f.repoRoot, f.path);
      const header = `// ${relPath}`;
      const meta: string[] = [];

      if (opts.includeReasons) meta.push(`reason: ${f.reason}`);
      if (opts.includeScores)  meta.push(`score: ${f.score.toFixed(2)}`);
      if (f.snippet)           meta.push(`symbol: ${f.snippet.symbol} (lines ${f.snippet.startLine}–${f.snippet.endLine})`);

      parts.push(header);
      if (meta.length > 0) parts.push(`// ${meta.join(' | ')}`);
      parts.push(f.content, '');
    }

    return parts.join('\n');
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function langFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const MAP: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx',
    '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python',
    '.go': 'go',
    '.java': 'java',
    '.rs': 'rust',
    '.rb': 'ruby',
  };
  return MAP[ext] ?? '';
}
