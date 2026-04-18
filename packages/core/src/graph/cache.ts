import { FileNode } from '../types';

interface CacheEntry {
  mtime: number;
  node: FileNode;
}

/**
 * In-memory cache for parsed FileNodes keyed by absolute path.
 * Enables incremental graph updates — only re-parse files whose mtime has changed.
 */
export class GraphCache {
  private cache = new Map<string, CacheEntry>();

  get(filePath: string, mtime: number): FileNode | null {
    const entry = this.cache.get(filePath);
    if (entry && entry.mtime === mtime) return entry.node;
    return null;
  }

  set(filePath: string, mtime: number, node: FileNode): void {
    this.cache.set(filePath, { mtime, node });
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  invalidateAll(filePaths: string[]): void {
    for (const p of filePaths) this.cache.delete(p);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
