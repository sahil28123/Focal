import * as fs from 'fs';
import * as path from 'path';
import { ChangeRecord } from '../types';

interface DbSchema {
  records: ChangeRecord[];
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class MemoryStore {
  private storagePath = '';
  private dbFile = '';
  private data: DbSchema = { records: [] };

  async init(storagePath: string): Promise<void> {
    this.storagePath = storagePath;
    this.dbFile = path.join(storagePath, 'memory.json');

    // Create directory if needed
    await fs.promises.mkdir(storagePath, { recursive: true });

    // Add .focal/ to .gitignore of parent repo if not already there
    await this.ensureGitignore(storagePath);

    // Load existing data
    try {
      const raw = await fs.promises.readFile(this.dbFile, 'utf8');
      this.data = JSON.parse(raw) as DbSchema;
    } catch {
      this.data = { records: [] };
      await this.persist();
    }
  }

  async add(record: Omit<ChangeRecord, 'id' | 'timestamp'>): Promise<ChangeRecord> {
    const full: ChangeRecord = {
      ...record,
      id: generateId(),
      timestamp: Date.now(),
    };
    this.data.records.push(full);
    await this.persist();
    return full;
  }

  async getRecent(limit = 20): Promise<ChangeRecord[]> {
    return [...this.data.records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getForFiles(filePaths: string[]): Promise<ChangeRecord[]> {
    const set = new Set(filePaths);
    return this.data.records.filter((r) => r.files.some((f) => set.has(f)));
  }

  async markOutcome(id: string, outcome: 'success' | 'failure'): Promise<void> {
    const record = this.data.records.find((r) => r.id === id);
    if (record) {
      record.outcome = outcome;
      await this.persist();
    }
  }

  async clear(): Promise<void> {
    this.data = { records: [] };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.promises.writeFile(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private async ensureGitignore(storagePath: string): Promise<void> {
    // Walk up to find the repo root (look for .git)
    let dir = path.dirname(storagePath);
    let depth = 0;
    while (depth < 5) {
      const gitDir = path.join(dir, '.git');
      try {
        await fs.promises.access(gitDir);
        // Found repo root
        const gitignorePath = path.join(dir, '.gitignore');
        const focalDir = path.relative(dir, storagePath);
        let existing = '';
        try {
          existing = await fs.promises.readFile(gitignorePath, 'utf8');
        } catch {
          // File doesn't exist yet
        }
        if (!existing.includes(focalDir)) {
          const line = existing.endsWith('\n') || existing === '' ? focalDir : `\n${focalDir}`;
          await fs.promises.appendFile(gitignorePath, line + '\n', 'utf8');
        }
        return;
      } catch {
        // .git not found here, go up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      depth++;
    }
  }
}
