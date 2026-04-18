import * as fs from 'fs';
import * as path from 'path';
import { ChangeRecord } from '../types';

interface DbSchema {
  records: ChangeRecord[];
}

const MAX_RECORDS = 500;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class MemoryStore {
  private storagePath = '';
  private dbFile = '';
  private data: DbSchema = { records: [] };

  // In-memory inverted index: filePath -> Set<recordId>
  // Turns getForFiles() from O(records × files) to O(filePaths)
  private fileIndex = new Map<string, Set<string>>();

  async init(storagePath: string): Promise<void> {
    this.storagePath = storagePath;
    this.dbFile = path.join(storagePath, 'memory.json');

    await fs.promises.mkdir(storagePath, { recursive: true });
    await this.ensureGitignore(storagePath);

    try {
      const raw = await fs.promises.readFile(this.dbFile, 'utf8');
      this.data = JSON.parse(raw) as DbSchema;
    } catch {
      this.data = { records: [] };
      await this.persist();
    }

    this.rebuildIndex();
  }

  async add(record: Omit<ChangeRecord, 'id' | 'timestamp'>): Promise<ChangeRecord> {
    const full: ChangeRecord = {
      ...record,
      id: generateId(),
      timestamp: Date.now(),
    };
    this.data.records.push(full);
    this.indexRecord(full);

    // LRU eviction: drop oldest records over cap
    if (this.data.records.length > MAX_RECORDS) {
      const evicted = this.data.records.splice(0, this.data.records.length - MAX_RECORDS);
      for (const r of evicted) this.unindexRecord(r);
    }

    await this.persist();
    return full;
  }

  async getRecent(limit = 20): Promise<ChangeRecord[]> {
    return [...this.data.records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getForFiles(filePaths: string[]): Promise<ChangeRecord[]> {
    const matchIds = new Set<string>();
    for (const fp of filePaths) {
      const ids = this.fileIndex.get(fp);
      if (ids) for (const id of ids) matchIds.add(id);
    }
    return this.data.records.filter((r) => matchIds.has(r.id));
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
    this.fileIndex.clear();
    await this.persist();
  }

  private rebuildIndex(): void {
    this.fileIndex.clear();
    for (const r of this.data.records) this.indexRecord(r);
  }

  private indexRecord(r: ChangeRecord): void {
    for (const file of r.files) {
      if (!this.fileIndex.has(file)) this.fileIndex.set(file, new Set());
      this.fileIndex.get(file)!.add(r.id);
    }
  }

  private unindexRecord(r: ChangeRecord): void {
    for (const file of r.files) {
      this.fileIndex.get(file)?.delete(r.id);
    }
  }

  private async persist(): Promise<void> {
    await fs.promises.writeFile(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private async ensureGitignore(storagePath: string): Promise<void> {
    let dir = path.dirname(storagePath);
    let depth = 0;
    while (depth < 5) {
      try {
        await fs.promises.access(path.join(dir, '.git'));
        const gitignorePath = path.join(dir, '.gitignore');
        const focalDir = path.relative(dir, storagePath);
        let existing = '';
        try { existing = await fs.promises.readFile(gitignorePath, 'utf8'); } catch { /* ok */ }
        if (!existing.includes(focalDir)) {
          const line = existing.endsWith('\n') || existing === '' ? focalDir : `\n${focalDir}`;
          await fs.promises.appendFile(gitignorePath, line + '\n', 'utf8');
        }
        return;
      } catch { /* .git not here */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      depth++;
    }
  }
}
