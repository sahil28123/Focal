#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  Focal, MemoryStore, MemoryAutoCollector, FocalFormatter, TaskIntentType, IncludedFile,
} from '@focal/core';

const program = new Command();

program
  .name('focal')
  .description('Context engine for AI coding agents')
  .version('0.1.0');

// ─── focal build ──────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Build an optimized context package for a query')
  .requiredOption('--repo <paths...>', 'Repo path(s) — pass multiple for multi-repo')
  .requiredOption('--query <text>', 'Task description / query')
  .option('--budget <tokens>', 'Token budget', '8000')
  .option('--output <file>', 'Write context JSON to file (default: stdout)')
  .option('--intent <type>', 'Override intent detection: bug_fix | feature | refactor | understand')
  .option('--stack-trace <file>', 'Path to stack trace file (boosts error signal)')
  .option('--test-output <file>', 'Path to test output file (boosts error signal)')
  .option('--diff <file>', 'Path to git diff --name-only output')
  .option('--format <style>', 'Output format for --output: xml-tags | markdown | plain | json', 'json')
  .action(async (opts) => {
    const repoPaths: string[] = (opts.repo as string[]).map((r: string) => path.resolve(r));
    const repoPath = repoPaths.length === 1 ? repoPaths[0] : repoPaths;
    const tokenBudget = parseInt(opts.budget, 10);

    // Load runtime signal files
    const runtimeSignals: { stackTrace?: string; testOutput?: string; recentDiff?: string } = {};
    if (opts.stackTrace) {
      try { runtimeSignals.stackTrace = fs.readFileSync(opts.stackTrace, 'utf8'); }
      catch { process.stderr.write(`Warning: could not read --stack-trace file: ${opts.stackTrace}\n`); }
    }
    if (opts.testOutput) {
      try { runtimeSignals.testOutput = fs.readFileSync(opts.testOutput, 'utf8'); }
      catch { process.stderr.write(`Warning: could not read --test-output file: ${opts.testOutput}\n`); }
    }
    if (opts.diff) {
      try { runtimeSignals.recentDiff = fs.readFileSync(opts.diff, 'utf8'); }
      catch { process.stderr.write(`Warning: could not read --diff file: ${opts.diff}\n`); }
    }

    try {
      const context = await Focal.build({
        repoPath,
        query: opts.query,
        tokenBudget,
        intent: opts.intent as TaskIntentType | undefined,
        runtimeSignals: Object.keys(runtimeSignals).length > 0 ? runtimeSignals : undefined,
      });

      const fullCount = context.files.filter((f) => f.resolution === 'full').length;
      const snipCount = context.files.filter((f) => f.resolution === 'snippet').length;
      const sigCount  = context.files.filter((f) => f.resolution === 'signature-only').length;
      const sumCount  = context.files.filter((f) => f.resolution === 'summary').length;
      const skipped   = context.graph.reachableButExcluded;
      const pct       = Math.round((context.tokensUsed / context.tokenBudget) * 100);
      const baseRepo  = Array.isArray(repoPath) ? repoPath[0] : repoPath;

      process.stdout.write(`Focal — context built in ${context.buildTimeMs}ms\n`);
      process.stdout.write(`─────────────────────────────────────────────────\n`);
      process.stdout.write(`Query:   ${context.query}\n`);
      process.stdout.write(`Intent:  ${context.intent.type} (${Math.round(context.intent.confidence * 100)}% confidence)\n`);
      process.stdout.write(`Budget:  ${context.tokenBudget} tokens\n`);
      process.stdout.write(`Used:    ${context.tokensUsed} tokens (${pct}%)\n`);
      process.stdout.write(`Files:   ${fullCount} full, ${snipCount} snippet, ${sigCount} sig-only, ${sumCount} summary, ${skipped} skipped\n`);
      if (context.pinnedFiles.length > 0) {
        process.stdout.write(`Pinned:  ${context.pinnedFiles.map((p) => path.relative(baseRepo, p)).join(', ')}\n`);
      }
      process.stdout.write(`\n`);

      for (const file of context.files as IncludedFile[]) {
        const bullet = file.resolution === 'full' ? '●'
          : file.resolution === 'snippet' ? '◆'
          : file.resolution === 'summary' ? '◇'
          : '◌';
        const pin    = file.runtimeContext?.appearsInStackTrace ? ' [stack]' : '';
        const relPath = path.relative(baseRepo, file.path).padEnd(44);
        const sym    = file.snippet ? ` :: ${file.snippet.symbol}` : '';
        process.stdout.write(
          `  ${bullet} ${relPath} (score: ${file.score.toFixed(2)})  ${file.resolution}${sym}${pin}\n`
        );
      }

      if (context.truncated) {
        process.stdout.write(`\n  ⚠ Context truncated — ${skipped} reachable files excluded by budget\n`);
      }

      if (opts.output) {
        const outPath = path.resolve(opts.output);
        let output: string;

        if (opts.format === 'json') {
          output = JSON.stringify(context, null, 2);
        } else {
          const formatter = new FocalFormatter();
          output = formatter.toPrompt(context, {
            style: opts.format as 'xml-tags' | 'markdown' | 'plain',
            includeReasons: true,
            includeScores: true,
          });
        }

        fs.writeFileSync(outPath, output, 'utf8');
        process.stdout.write(`\nContext written to: ${opts.output}\n`);
      } else {
        process.stdout.write(`\n`);
        process.stdout.write(JSON.stringify(context, null, 2));
        process.stdout.write(`\n`);
      }
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ─── focal memory ─────────────────────────────────────────────────────────────

const memCmd = program.command('memory').description('Manage change memory');

memCmd
  .command('add')
  .description('Record a change')
  .requiredOption('--repo <path>', 'Repo path')
  .requiredOption('--description <text>', 'Change description')
  .requiredOption('--files <paths>', 'Comma-separated file paths')
  .option('--type <type>', 'change | fix | failed_attempt', 'change')
  .option('--outcome <outcome>', 'success | failure')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const store = new MemoryStore();
    await store.init(path.join(repoPath, '.focal'));
    const files = (opts.files as string).split(',').map((f) => path.resolve(repoPath, f.trim()));
    const record = await store.add({
      type: opts.type as 'change' | 'fix' | 'failed_attempt',
      files,
      description: opts.description,
      outcome: opts.outcome,
    });
    process.stdout.write(`Recorded: ${record.id}\n`);
  });

memCmd
  .command('ingest-diff')
  .description('Auto-record files from a git diff')
  .requiredOption('--repo <path>', 'Repo path')
  .requiredOption('--description <text>', 'Change description')
  .requiredOption('--diff <file>', 'Path to git diff --name-only output')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const store = new MemoryStore();
    await store.init(path.join(repoPath, '.focal'));
    const collector = new MemoryAutoCollector(store);
    const diff = fs.readFileSync(opts.diff, 'utf8');
    await collector.ingestDiff(diff, opts.description, repoPath);
    process.stdout.write(`Diff ingested into memory.\n`);
  });

memCmd
  .command('outcome')
  .description('Mark the outcome of a recorded build')
  .requiredOption('--repo <path>', 'Repo path')
  .requiredOption('--id <id>', 'Record ID')
  .requiredOption('--outcome <outcome>', 'success | failure')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const store = new MemoryStore();
    await store.init(path.join(repoPath, '.focal'));
    await store.markOutcome(opts.id, opts.outcome as 'success' | 'failure');
    process.stdout.write(`Outcome recorded.\n`);
  });

memCmd
  .command('list')
  .description('List recent memory records')
  .requiredOption('--repo <path>', 'Repo path')
  .option('--limit <n>', 'Max records', '10')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const store = new MemoryStore();
    await store.init(path.join(repoPath, '.focal'));
    const records = await store.getRecent(parseInt(opts.limit, 10));
    if (records.length === 0) { process.stdout.write('No records.\n'); return; }
    for (const r of records) {
      const date = new Date(r.timestamp).toISOString().slice(0, 19).replace('T', ' ');
      process.stdout.write(`[${date}] ${r.type}${r.outcome ? ` (${r.outcome})` : ''}: ${r.description}\n`);
      process.stdout.write(`  Files: ${r.files.join(', ')}\n`);
    }
  });

program.parse(process.argv);
