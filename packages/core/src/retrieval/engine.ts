import * as fs from 'fs';
import { CodeGraph, ContextCandidate } from '../types';
import { MemoryStore } from '../memory/store';
import { TFIDFIndex, TFIDFDocument, cosineSimilarity } from './tfidf';

function tokenizeQuery(query: string): string[] {
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

export interface RetrievalOptions {
  topK?: number;
  embed?: (texts: string[]) => Promise<number[][]>;
}

export class RetrievalEngine {
  async retrieve(
    query: string,
    graph: CodeGraph,
    memory: MemoryStore,
    options?: RetrievalOptions
  ): Promise<ContextCandidate[]> {
    const topK = options?.topK ?? 50;
    const tokens = tokenizeQuery(query);
    const allFilePaths = [...graph.files.keys()];

    // Read all file contents upfront (needed for TF-IDF and keyword scoring)
    const contentMap = new Map<string, string>();
    await Promise.all(
      allFilePaths.map(async (filePath) => {
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          contentMap.set(filePath, content);
        } catch {
          // Skip unreadable files
        }
      })
    );

    // Step 1: Build TF-IDF index over all files
    const tfidf = new TFIDFIndex();
    const docs: TFIDFDocument[] = [];
    for (const [filePath, fileNode] of graph.files) {
      const content = contentMap.get(filePath) ?? '';
      const fnNames = fileNode.functions.map((f) => f.name).join(' ');
      const clsNames = fileNode.classes.map((c) => c.name).join(' ');
      docs.push({ id: filePath, text: `${filePath} ${fnNames} ${clsNames} ${content}` });
    }
    tfidf.build(docs);
    const tfidfScores = tfidf.query(query);

    // Step 2: Optional embedding similarity boost
    const embeddingScores = new Map<string, number>();
    if (options?.embed && allFilePaths.length > 0) {
      try {
        const textsToEmbed = [query, ...allFilePaths.map((p) => {
          const fileNode = graph.files.get(p)!;
          const content = contentMap.get(p) ?? '';
          // Use a compact representation for embedding: path + symbols + first 500 chars
          const symbols = [
            ...fileNode.functions.map((f) => f.name),
            ...fileNode.classes.map((c) => c.name),
          ].join(' ');
          return `${p} ${symbols} ${content.slice(0, 500)}`;
        })];

        const vectors = await options.embed(textsToEmbed);
        const queryVec = vectors[0];

        for (let i = 0; i < allFilePaths.length; i++) {
          const sim = cosineSimilarity(queryVec, vectors[i + 1]);
          embeddingScores.set(allFilePaths[i], Math.max(0, sim));
        }

        // Normalize embedding scores to 0-1
        const maxSim = Math.max(...embeddingScores.values(), 0.001);
        for (const [k, v] of embeddingScores) {
          embeddingScores.set(k, v / maxSim);
        }
      } catch {
        // If embedding fails, fall back to TF-IDF only
      }
    }

    // Step 3: Combine TF-IDF + keyword + optional embedding into relevance score
    const relevanceMap = new Map<string, number>();
    for (const [filePath, fileNode] of graph.files) {
      const pathScore = keywordScore(tokens, filePath);
      const fnScore = fileNode.functions.reduce(
        (max, fn) => Math.max(max, keywordScore(tokens, fn.name)),
        0
      );
      const tfidf = tfidfScores.get(filePath) ?? 0;
      const embedding = embeddingScores.get(filePath) ?? 0;

      // Blend: TF-IDF (0.5) + keyword path/fn (0.3) + embedding (0.2 if available, else redistribute)
      const hasEmbedding = options?.embed !== undefined;
      const score = hasEmbedding
        ? tfidf * 0.5 + (pathScore * 0.5 + fnScore * 0.5) * 0.3 + embedding * 0.2
        : tfidf * 0.6 + (pathScore * 0.5 + fnScore * 0.5) * 0.4;

      relevanceMap.set(filePath, Math.min(1, score));
    }

    // Step 4: Identify seed files (top relevance matches)
    const sorted = allFilePaths
      .filter((p) => (relevanceMap.get(p) ?? 0) > 0)
      .sort((a, b) => (relevanceMap.get(b) ?? 0) - (relevanceMap.get(a) ?? 0));
    const seeds = new Set(sorted.slice(0, 10));

    // Step 5: Import graph traversal — walk out 2 hops from seeds
    const dependencyMap = new Map<string, number>();
    for (const seed of seeds) {
      dependencyMap.set(seed, 1.0);
      const hop1 = graph.importGraph.get(seed) ?? [];
      for (const dep of hop1) {
        if (graph.files.has(dep)) {
          dependencyMap.set(dep, Math.max(dependencyMap.get(dep) ?? 0, 0.7));
          const hop2 = graph.importGraph.get(dep) ?? [];
          for (const dep2 of hop2) {
            if (graph.files.has(dep2)) {
              dependencyMap.set(dep2, Math.max(dependencyMap.get(dep2) ?? 0, 0.4));
            }
          }
        }
      }
    }

    // Step 6: Memory linkage — error signal from past change records
    const candidateFiles = allFilePaths.filter(
      (p) => (relevanceMap.get(p) ?? 0) > 0 || dependencyMap.has(p)
    );
    const memoryRecords = await memory.getForFiles(candidateFiles);

    const errorSignalMap = new Map<string, number>();
    for (const record of memoryRecords) {
      const descTokens = tokenizeQuery(record.description);
      const overlap =
        descTokens.filter((t) => tokens.includes(t)).length / Math.max(tokens.length, 1);
      const boost = overlap * (record.outcome === 'failure' ? 1.0 : 0.5);
      for (const file of record.files) {
        errorSignalMap.set(file, Math.min(1, (errorSignalMap.get(file) ?? 0) + boost));
      }
    }

    // Step 7: Build ContextCandidate list
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
        finalScore: 0,
        tokenEstimate: Math.ceil(fileNode.size / 4),
      });
    };

    for (const p of candidateFiles) addCandidate(p);
    for (const p of dependencyMap.keys()) addCandidate(p);

    candidates.sort(
      (a, b) =>
        b.scores.relevance + b.scores.dependency + b.scores.errorSignal -
        (a.scores.relevance + a.scores.dependency + a.scores.errorSignal)
    );

    return candidates.slice(0, topK);
  }
}
