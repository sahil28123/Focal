import * as fs from 'fs';
import { CodeGraph, ContextCandidate } from '../types';
import { MemoryStore } from '../memory/store';

function tokenizeQuery(query: string): string[] {
  // Split on spaces, camelCase, snake_case, and punctuation
  return query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function keywordScore(tokens: string[], text: string): number {
  const lower = text.toLowerCase();
  let matches = 0;
  for (const token of tokens) {
    if (lower.includes(token)) matches++;
  }
  return tokens.length > 0 ? matches / tokens.length : 0;
}

export class RetrievalEngine {
  async retrieve(
    query: string,
    graph: CodeGraph,
    memory: MemoryStore,
    options?: { topK?: number }
  ): Promise<ContextCandidate[]> {
    const topK = options?.topK ?? 50;
    const tokens = tokenizeQuery(query);
    const allFilePaths = [...graph.files.keys()];

    // Step 1: Keyword match for each file
    const relevanceMap = new Map<string, number>();
    for (const [filePath, fileNode] of graph.files) {
      const pathScore = keywordScore(tokens, filePath);
      let contentScore = 0;
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        contentScore = keywordScore(tokens, content) * 0.5; // content weighted less than path/name
      } catch {
        // Skip unreadable files
      }
      const fnScore = fileNode.functions.reduce((max, fn) => {
        return Math.max(max, keywordScore(tokens, fn.name));
      }, 0);
      relevanceMap.set(filePath, Math.min(1, pathScore * 0.4 + fnScore * 0.3 + contentScore * 0.3));
    }

    // Step 2: Identify seed files (top keyword matches)
    const sorted = allFilePaths
      .filter((p) => (relevanceMap.get(p) ?? 0) > 0)
      .sort((a, b) => (relevanceMap.get(b) ?? 0) - (relevanceMap.get(a) ?? 0));
    const seeds = new Set(sorted.slice(0, 10));

    // Step 3: Import graph traversal — walk out 2 hops from seeds
    const dependencyMap = new Map<string, number>();
    for (const seed of seeds) {
      dependencyMap.set(seed, 1.0); // seed itself gets max dep score
      const hop1 = graph.importGraph.get(seed) ?? [];
      for (const dep of hop1) {
        if (graph.files.has(dep)) {
          const existing = dependencyMap.get(dep) ?? 0;
          dependencyMap.set(dep, Math.max(existing, 0.7));
          const hop2 = graph.importGraph.get(dep) ?? [];
          for (const dep2 of hop2) {
            if (graph.files.has(dep2)) {
              const existing2 = dependencyMap.get(dep2) ?? 0;
              dependencyMap.set(dep2, Math.max(existing2, 0.4));
            }
          }
        }
      }
    }

    // Step 4: Memory linkage — boost error signal for files in past change records
    const candidateFiles = allFilePaths.filter(
      (p) => (relevanceMap.get(p) ?? 0) > 0 || dependencyMap.has(p)
    );
    const memoryRecords = await memory.getForFiles(candidateFiles);

    const errorSignalMap = new Map<string, number>();
    for (const record of memoryRecords) {
      // Simple string overlap on description vs query
      const descTokens = tokenizeQuery(record.description);
      const overlap =
        descTokens.filter((t) => tokens.includes(t)).length / Math.max(tokens.length, 1);
      const boost = overlap * (record.outcome === 'failure' ? 1.0 : 0.5);
      for (const file of record.files) {
        const existing = errorSignalMap.get(file) ?? 0;
        errorSignalMap.set(file, Math.min(1, existing + boost));
      }
    }

    // Step 5: Build ContextCandidate list
    const candidates: ContextCandidate[] = [];
    const visited = new Set<string>();

    const addCandidate = (filePath: string): void => {
      if (visited.has(filePath)) return;
      visited.add(filePath);
      const fileNode = graph.files.get(filePath);
      if (!fileNode) return;

      candidates.push({
        type: 'file',
        path: filePath,
        scores: {
          relevance: relevanceMap.get(filePath) ?? 0,
          dependency: dependencyMap.get(filePath) ?? 0,
          recency: 0, // computed in scorer
          errorSignal: errorSignalMap.get(filePath) ?? 0,
        },
        finalScore: 0, // computed in scorer
        tokenEstimate: Math.ceil(fileNode.size / 4),
      });
    };

    for (const filePath of candidateFiles) {
      addCandidate(filePath);
    }
    // Also include any dependency-reachable files not yet added
    for (const filePath of dependencyMap.keys()) {
      addCandidate(filePath);
    }

    // Sort by combined raw signals, return topK
    candidates.sort(
      (a, b) =>
        b.scores.relevance + b.scores.dependency + b.scores.errorSignal -
        (a.scores.relevance + a.scores.dependency + a.scores.errorSignal)
    );

    return candidates.slice(0, topK);
  }
}
