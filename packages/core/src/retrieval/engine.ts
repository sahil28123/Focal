import * as fs from 'fs';
import { CodeGraph, ContextCandidate, TaskIntent, PinnedNode } from '../types';
import { MemoryStore } from '../memory/store';
import { FailurePatternIndex } from '../memory/pattern-index';
import { BreakagePredictor } from '../prediction/breakage';
import { TFIDFIndex, TFIDFDocument, cosineSimilarity } from './tfidf';

export interface RetrievalOptions {
  topK?: number;
  intent?: TaskIntent;
  pinnedNodes?: PinnedNode[];
  boostMap?: Map<string, number>;
  embed?: (texts: string[]) => Promise<number[][]>;
}

export { FailurePatternIndex };

export interface RetrievalResult {
  candidates: ContextCandidate[];
  seedFiles: string[];
  patternHits: number;   // how many failure patterns matched — used for confidence estimation
}

// A function-level candidate scores higher than its file average by this ratio
// before we split it out as a function-level candidate rather than a file candidate.
const FUNCTION_SPLIT_RATIO = 2.0;
const FUNCTION_SPLIT_MIN_SCORE = 0.5;

/** Build a caller index (inverse of callGraph) for "who calls this function" lookups. */
function buildCallerIndex(callGraph: Map<string, string[]>): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  for (const [callerId, callees] of callGraph) {
    for (const callee of callees) {
      if (!callers.has(callee)) callers.set(callee, new Set());
      callers.get(callee)!.add(callerId);
    }
  }
  return callers;
}

function tokenizeQuery(query: string): string[] {
  return query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export class RetrievalEngine {
  async retrieve(
    query: string,
    graph: CodeGraph,
    memory: MemoryStore,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult> {
    const {
      topK = 60,
      intent,
      pinnedNodes = [],
      boostMap = new Map(),
      embed,
    } = options;

    const allFilePaths = [...graph.files.keys()];
    if (allFilePaths.length === 0) {
      return { candidates: [], seedFiles: [], patternHits: 0 };
    }

    // ── Step 1: Read file contents ───────────────────────────────────────────
    const contentMap = new Map<string, string>();
    await Promise.all(
      allFilePaths.map(async (fp) => {
        try {
          contentMap.set(fp, await fs.promises.readFile(fp, 'utf8'));
        } catch { /* skip */ }
      })
    );

    // ── Step 2: Build function-level BM25 index ──────────────────────────────
    const tfidf = new TFIDFIndex();
    const docs: TFIDFDocument[] = [];

    for (const [filePath, fileNode] of graph.files) {
      const content = contentMap.get(filePath) ?? '';
      const fileLines = content.split('\n');

      // One doc per function (core insight: query "validateToken expiry" should
      // score the function, not the 600-line file)
      for (const fn of fileNode.functions) {
        const body = fileLines.slice(fn.startLine - 1, fn.endLine).join('\n');
        docs.push({
          id: `${filePath}::${fn.name}`,
          filePath,
          text: `${fn.name} ${fn.params.join(' ')} ${fn.calls.join(' ')} ${body}`,
        });
      }

      // One doc per class
      for (const cls of fileNode.classes) {
        docs.push({
          id: `${filePath}::${cls.name}`,
          filePath,
          text: `${cls.name} ${cls.methods.join(' ')} ${cls.extends ?? ''}`,
        });
      }

      // File-level doc for files with no functions (e.g. config files, type defs)
      if (fileNode.functions.length === 0 && fileNode.classes.length === 0) {
        docs.push({
          id: filePath,
          filePath,
          text: `${filePath} ${fileNode.exports.join(' ')} ${content.slice(0, 800)}`,
        });
      }
    }

    tfidf.build(docs);

    // ── Step 3: BM25 scores by file (max of function scores) ─────────────────
    const tfidfByFile = tfidf.queryByFile(query);
    const tfidfByDoc = tfidf.query(query);

    // ── Step 4: Optional embedding similarity ────────────────────────────────
    const embeddingByFile = new Map<string, number>();
    if (embed && allFilePaths.length > 0) {
      try {
        const queryText = query;
        const fileTexts = allFilePaths.map((fp) => {
          const fn = graph.files.get(fp)!;
          const symbols = [...fn.functions.map((f) => f.name), ...fn.classes.map((c) => c.name)];
          return `${fp} ${symbols.join(' ')} ${(contentMap.get(fp) ?? '').slice(0, 400)}`;
        });

        const vectors = await embed([queryText, ...fileTexts]);
        const qVec = vectors[0];
        const maxSim = Math.max(
          ...vectors.slice(1).map((v) => cosineSimilarity(qVec, v)),
          0.001
        );
        for (let i = 0; i < allFilePaths.length; i++) {
          const sim = cosineSimilarity(qVec, vectors[i + 1]);
          embeddingByFile.set(allFilePaths[i], Math.max(0, sim) / maxSim);
        }
      } catch { /* fall back to BM25 only */ }
    }

    // ── Step 5: Blended relevance score per file ──────────────────────────────
    const relevanceByFile = new Map<string, number>();
    const hasEmbedding = embeddingByFile.size > 0;

    for (const fp of allFilePaths) {
      const bm25 = tfidfByFile.get(fp) ?? 0;
      const emb = embeddingByFile.get(fp) ?? 0;
      const score = hasEmbedding
        ? bm25 * 0.55 + emb * 0.45
        : bm25;
      relevanceByFile.set(fp, Math.min(1, score));
    }

    // ── Step 6: Seed files (top relevance + pinned) ───────────────────────────
    const seedFiles = allFilePaths
      .filter((p) => (relevanceByFile.get(p) ?? 0) > 0)
      .sort((a, b) => (relevanceByFile.get(b) ?? 0) - (relevanceByFile.get(a) ?? 0))
      .slice(0, 12);

    const seedSet = new Set(seedFiles);

    // Pinned files are always seeds
    for (const pin of pinnedNodes) seedSet.add(pin.filePath);

    // ── Step 7: Import graph traversal (2 hops from seeds) ───────────────────
    const depScore = new Map<string, number>();
    for (const seed of seedSet) {
      depScore.set(seed, Math.max(depScore.get(seed) ?? 0, 1.0));
      for (const hop1 of graph.importGraph.get(seed) ?? []) {
        if (!graph.files.has(hop1)) continue;
        depScore.set(hop1, Math.max(depScore.get(hop1) ?? 0, 0.7));
        for (const hop2 of graph.importGraph.get(hop1) ?? []) {
          if (!graph.files.has(hop2)) continue;
          depScore.set(hop2, Math.max(depScore.get(hop2) ?? 0, 0.4));
        }
      }
    }

    // ── Step 8: Call graph traversal (intent-aware direction) ─────────────────
    const intentType = intent?.type ?? 'understand';
    const callerIndex = (intentType === 'bug_fix' || intentType === 'refactor')
      ? buildCallerIndex(graph.callGraph)
      : null;

    // Find seed functions (highest BM25 scoring functions in seed files)
    const seedFunctionIds: string[] = [];
    for (const fp of seedSet) {
      const best = tfidf.topFunctionInFile(fp, query);
      if (best && best.score > 0.3) seedFunctionIds.push(best.id);
    }

    // Walk call graph based on intent
    const callGraphBoost = new Map<string, number>(); // filePath -> boost

    for (const seedFnId of seedFunctionIds) {
      if (intentType === 'bug_fix' || intentType === 'refactor') {
        // Walk UP: find callers (all call sites of this function)
        const callers1 = callerIndex?.get(seedFnId) ?? new Set<string>();
        for (const callerId of callers1) {
          const callerFile = callerId.split('::')[0];
          callGraphBoost.set(callerFile, Math.max(callGraphBoost.get(callerFile) ?? 0, 0.65));
          // 2nd hop callers
          for (const callerId2 of callerIndex?.get(callerId) ?? new Set<string>()) {
            const f = callerId2.split('::')[0];
            callGraphBoost.set(f, Math.max(callGraphBoost.get(f) ?? 0, 0.35));
          }
        }
      }
      if (intentType === 'feature' || intentType === 'understand' || intentType === 'refactor') {
        // Walk DOWN: find callees (what this function depends on)
        const callees1 = graph.callGraph.get(seedFnId) ?? [];
        for (const calleeId of callees1) {
          const calleeFile = calleeId.split('::')[0];
          callGraphBoost.set(calleeFile, Math.max(callGraphBoost.get(calleeFile) ?? 0, 0.6));
          for (const calleeId2 of graph.callGraph.get(calleeId) ?? []) {
            const f = calleeId2.split('::')[0];
            callGraphBoost.set(f, Math.max(callGraphBoost.get(f) ?? 0, 0.3));
          }
        }
      }
    }

    // Merge call graph boost into dependency scores
    for (const [fp, boost] of callGraphBoost) {
      if (graph.files.has(fp)) {
        depScore.set(fp, Math.max(depScore.get(fp) ?? 0, boost));
      }
    }

    // ── Step 9: Memory linkage — error signal from past records + pattern index ─
    const candidateFiles = allFilePaths.filter(
      (p) => (relevanceByFile.get(p) ?? 0) > 0 || depScore.has(p) || boostMap.has(p)
    );
    const memoryRecords = await memory.getForFiles(candidateFiles);

    // Build failure pattern index from all records (not just candidate files)
    const allRecords = await memory.getRecent(500);
    const patternIndex = new FailurePatternIndex();
    patternIndex.build(allRecords);
    const patternBoosts = patternIndex.getBoosts(query);

    const queryTokens = tokenizeQuery(query);
    const errorSignalByFile = new Map<string, number>();

    // 1. Runtime signal boosts (highest priority — directly from stack traces etc.)
    for (const [fp, boost] of boostMap) {
      errorSignalByFile.set(fp, boost);
    }

    // 2. Failure pattern boosts (from past similar failures)
    for (const [fp, boost] of patternBoosts) {
      errorSignalByFile.set(fp, Math.min(1, (errorSignalByFile.get(fp) ?? 0) + boost * 0.6));
    }

    // 3. Memory record linkage (simple overlap — kept for non-failure records)
    for (const record of memoryRecords) {
      const descTokens = tokenizeQuery(record.description);
      const overlap =
        descTokens.filter((t) => queryTokens.includes(t)).length /
        Math.max(queryTokens.length, 1);
      const boost = overlap * (record.outcome === 'failure' ? 1.0 : 0.4);
      if (boost < 0.1) continue;
      for (const file of record.files) {
        errorSignalByFile.set(file, Math.min(1, (errorSignalByFile.get(file) ?? 0) + boost));
      }
    }

    // ── Step 9b: Breakage prediction — add at-risk callers ───────────────────
    // Only for bug_fix and refactor — don't expand scope for feature/understand
    const intentType2 = intent?.type ?? 'understand';
    if ((intentType2 === 'bug_fix' || intentType2 === 'refactor') && pinnedNodes.length > 0) {
      const predictor = new BreakagePredictor();
      const risks = predictor.predict(pinnedNodes, graph, []);
      const riskCandidates = predictor.toContextCandidates(risks, graph);
      // Merge risk candidates' errorSignal into the map
      for (const rc of riskCandidates) {
        errorSignalByFile.set(
          rc.path,
          Math.min(1, (errorSignalByFile.get(rc.path) ?? 0) + rc.scores.errorSignal)
        );
        // Also add them to depScore so they reach the candidate list
        depScore.set(rc.path, Math.max(depScore.get(rc.path) ?? 0, rc.scores.dependency));
      }
    }

    // ── Step 10: Build candidate list ────────────────────────────────────────
    const candidates: ContextCandidate[] = [];
    const visitedFiles = new Set<string>();

    const addFilePaths = new Set([...candidateFiles, ...depScore.keys()]);

    for (const fp of addFilePaths) {
      if (visitedFiles.has(fp)) continue;
      visitedFiles.add(fp);

      const fileNode = graph.files.get(fp);
      if (!fileNode) continue;

      const isPinned = pinnedNodes.some((p) => p.filePath === fp);
      const fileRelevance = relevanceByFile.get(fp) ?? 0;

      // Decide granularity: function-level vs file-level
      // Emit a function-level candidate if one function dominates the file's score
      if (!isPinned && fileNode.functions.length > 0) {
        const best = tfidf.topFunctionInFile(fp, query);
        if (best && best.score >= FUNCTION_SPLIT_MIN_SCORE) {
          // Average score across all functions in this file
          const avgFnScore =
            fileNode.functions.reduce(
              (s, fn) => s + (tfidfByDoc.get(`${fp}::${fn.name}`) ?? 0),
              0
            ) / fileNode.functions.length;

          if (best.score >= avgFnScore * FUNCTION_SPLIT_RATIO) {
            // This one function is much more relevant than the rest — include it as snippet
            const fnName = best.id.split('::')[1];
            const fn = fileNode.functions.find((f) => f.name === fnName);
            if (fn) {
              const lineCount = fn.endLine - fn.startLine + 1;
              candidates.push({
                type: 'function',
                path: fp,
                functionName: fnName,
                startLine: fn.startLine,
                endLine: fn.endLine,
                scores: {
                  relevance: best.score,
                  dependency: depScore.get(fp) ?? 0,
                  recency: 0,
                  errorSignal: errorSignalByFile.get(fp) ?? 0,
                },
                finalScore: 0,
                tokenEstimate: Math.ceil((lineCount * 60) / 4),
                pinned: false,
              });
              continue; // don't also add a file-level candidate
            }
          }
        }
      }

      // File-level candidate
      candidates.push({
        type: 'file',
        path: fp,
        scores: {
          relevance: fileRelevance,
          dependency: depScore.get(fp) ?? 0,
          recency: 0,
          errorSignal: errorSignalByFile.get(fp) ?? 0,
        },
        finalScore: 0,
        tokenEstimate: Math.ceil(fileNode.size / 4),
        pinned: isPinned,
      });
    }

    // Pinned nodes: ensure they're in the list and at full errorSignal
    for (const pin of pinnedNodes) {
      if (!visitedFiles.has(pin.filePath)) {
        const fileNode = graph.files.get(pin.filePath);
        if (!fileNode) continue;
        candidates.push({
          type: 'file',
          path: pin.filePath,
          scores: {
            relevance: relevanceByFile.get(pin.filePath) ?? 0,
            dependency: depScore.get(pin.filePath) ?? 0,
            recency: 0,
            errorSignal: pin.errorSignalBoost,
          },
          finalScore: 0,
          tokenEstimate: Math.ceil(fileNode.size / 4),
          pinned: true,
        });
      }
    }

    // Pre-sort by raw combined signal for topK cutoff
    candidates.sort(
      (a, b) =>
        (b.scores.relevance + b.scores.dependency + b.scores.errorSignal + (b.pinned ? 2 : 0)) -
        (a.scores.relevance + a.scores.dependency + a.scores.errorSignal + (a.pinned ? 2 : 0))
    );

    // Always keep pinned; cap non-pinned at topK
    const pinned = candidates.filter((c) => c.pinned);
    const nonPinned = candidates.filter((c) => !c.pinned).slice(0, topK - pinned.length);

    return {
      candidates: [...pinned, ...nonPinned],
      seedFiles: [...seedSet].slice(0, 10),
      patternHits: patternIndex.matchCount(query),
    };
  }
}
