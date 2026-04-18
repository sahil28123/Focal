#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { Focal, MemoryStore, IncludedFile } from '@focal/core';

const program = new Command();

program
  .name('focal')
  .description('Context engine for AI coding agents')
  .version('0.1.0');

// focal build
program
  .command('build')
  .description('Build an optimized context package for a query')
  .requiredOption('--repo <path>', 'Path to the repository')
  .requiredOption('--query <text>', 'Task description / query')
  .option('--budget <tokens>', 'Token budget', '8000')
  .option('--output <file>', 'Write context JSON to this file (default: stdout)')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const tokenBudget = parseInt(opts.budget, 10);

    try {
      const context = await Focal.build({
        repoPath,
        query: opts.query,
        tokenBudget,
      });

      const fullCount = context.files.filter((f) => f.resolution === 'full').length;
      const sigCount = context.files.filter((f) => f.resolution === 'signature-only').length;
      const totalCandidates = context.files.length;
      const skipped = Math.max(0, totalCandidates - fullCount - sigCount);
      const pct = Math.round((context.tokensUsed / context.tokenBudget) * 100);

      process.stdout.write(`Focal — context built in ${context.buildTimeMs}ms\n`);
      process.stdout.write(`─────────────────────────────────────\n`);
      process.stdout.write(`Query:   ${context.query}\n`);
      process.stdout.write(`Budget:  ${context.tokenBudget} tokens\n`);
      process.stdout.write(`Used:    ${context.tokensUsed} tokens (${pct}%)\n`);
      process.stdout.write(
        `Files:   ${fullCount} included, ${sigCount} signature-only, ${skipped} skipped\n`
      );
      process.stdout.write(`\n`);

      for (const file of context.files as IncludedFile[]) {
        const bullet = file.resolution === 'full' ? '●' : '◌';
        const relPath = path.relative(repoPath, file.path);
        process.stdout.write(
          `  ${bullet} ${relPath.padEnd(40)} (score: ${file.score.toFixed(2)})  ${file.resolution}\n`
        );
      }

      if (opts.output) {
        const outPath = path.resolve(opts.output);
        fs.writeFileSync(outPath, JSON.stringify(context, null, 2), 'utf8');
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

// focal memory
const memoryCmd = program.command('memory').description('Manage change memory');

memoryCmd
  .command('add')
  .description('Record a change in memory')
  .requiredOption('--repo <path>', 'Path to the repository')
  .requiredOption('--description <text>', 'Description of the change')
  .requiredOption('--files <paths>', 'Comma-separated list of changed files')
  .option('--type <type>', 'Type: change | fix | failed_attempt', 'change')
  .option('--diff <text>', 'Optional diff text')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const memoryPath = path.join(repoPath, '.focal');
    const store = new MemoryStore();
    await store.init(memoryPath);

    const files = (opts.files as string)
      .split(',')
      .map((f) => path.resolve(repoPath, f.trim()));

    const record = await store.add({
      type: opts.type as 'change' | 'fix' | 'failed_attempt',
      files,
      description: opts.description,
      diff: opts.diff,
    });

    process.stdout.write(`Recorded change: ${record.id}\n`);
  });

memoryCmd
  .command('list')
  .description('List recent memory records')
  .requiredOption('--repo <path>', 'Path to the repository')
  .option('--limit <n>', 'Max records to show', '10')
  .action(async (opts) => {
    const repoPath = path.resolve(opts.repo);
    const memoryPath = path.join(repoPath, '.focal');
    const store = new MemoryStore();
    await store.init(memoryPath);

    const records = await store.getRecent(parseInt(opts.limit, 10));
    if (records.length === 0) {
      process.stdout.write('No memory records found.\n');
      return;
    }
    for (const r of records) {
      const date = new Date(r.timestamp).toISOString();
      process.stdout.write(`[${date}] ${r.type}: ${r.description}\n`);
      process.stdout.write(`  Files: ${r.files.join(', ')}\n`);
      if (r.outcome) process.stdout.write(`  Outcome: ${r.outcome}\n`);
    }
  });

program.parse(process.argv);
