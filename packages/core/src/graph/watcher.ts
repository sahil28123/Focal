import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const DEBOUNCE_MS = 150;
const WATCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.focal']);

export interface WatchEvent {
  type: 'change' | 'add' | 'remove';
  filePath: string;
}

/**
 * Watches one or more repo directories for file changes using Node's built-in fs.watch.
 * Zero external dependencies.
 *
 * Emits 'change' events with WatchEvent payloads.
 * Call stop() to tear down all watchers.
 */
export class RepoWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  watch(repoPaths: string | string[]): void {
    const paths = Array.isArray(repoPaths) ? repoPaths : [repoPaths];

    for (const repoPath of paths) {
      try {
        const watcher = fs.watch(
          repoPath,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;

            const ext = path.extname(filename).toLowerCase();
            if (!WATCHED_EXTENSIONS.has(ext)) return;

            // Skip files inside ignored directories
            const parts = filename.split(path.sep);
            if (parts.some((p) => SKIP_DIRS.has(p))) return;

            const fullPath = path.join(repoPath, filename);

            // Debounce rapid successive events for the same file
            const existing = this.debounceTimers.get(fullPath);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(() => {
              this.debounceTimers.delete(fullPath);
              fs.stat(fullPath, (err, stat) => {
                if (err) {
                  this.emit('change', { type: 'remove', filePath: fullPath } as WatchEvent);
                } else if (stat.isFile()) {
                  const type = eventType === 'rename' ? 'add' : 'change';
                  this.emit('change', { type, filePath: fullPath } as WatchEvent);
                }
              });
            }, DEBOUNCE_MS);

            this.debounceTimers.set(fullPath, timer);
          }
        );

        watcher.on('error', () => {
          // Silently ignore watch errors (e.g. permission denied on subdirs)
        });

        this.watchers.push(watcher);
      } catch {
        // fs.watch may not support recursive on all platforms; fail silently
      }
    }
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }
}
