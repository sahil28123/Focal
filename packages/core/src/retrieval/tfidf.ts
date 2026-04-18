/**
 * BM25 implementation — zero dependencies, pure math.
 *
 * Documents are indexed at function/class level (not file level).
 * This means querying "validate token expiry" scores the function
 * `validateTokenExpiry()` at 0.9 instead of the entire 600-line file at 0.3.
 */

const K1 = 1.5;  // term frequency saturation
const B = 0.75;  // length normalization

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')        // camelCase → tokens
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export interface TFIDFDocument {
  /** Unique id — use `filePath` for files or `filePath::functionName` for functions. */
  id: string;
  /** The parent file path. Used to aggregate function scores back to file level. */
  filePath: string;
  text: string;
}

interface IndexedDoc {
  id: string;
  filePath: string;
  tf: Map<string, number>;
  length: number;
}

export class TFIDFIndex {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  build(documents: TFIDFDocument[]): void {
    this.docs = [];
    this.df = new Map();

    for (const doc of documents) {
      const tokens = tokenize(doc.text);
      const tf = termFrequency(tokens);
      this.docs.push({ id: doc.id, filePath: doc.filePath, tf, length: tokens.length });
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }

    this.avgLen =
      this.docs.length > 0
        ? this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length
        : 1;
  }

  /**
   * Score all documents against a query using BM25.
   * Returns normalized scores (0–1) keyed by document id.
   */
  query(queryText: string): Map<string, number> {
    const qTokens = tokenize(queryText);
    const N = this.docs.length;
    if (N === 0 || qTokens.length === 0) return new Map();

    const raw = new Map<string, number>();

    for (const term of qTokens) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const doc of this.docs) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / this.avgLen));
        raw.set(doc.id, (raw.get(doc.id) ?? 0) + idf * norm);
      }
    }

    if (raw.size === 0) return raw;
    const max = Math.max(...raw.values());
    if (max === 0) return raw;

    const normalized = new Map<string, number>();
    for (const [id, score] of raw) normalized.set(id, score / max);
    return normalized;
  }

  /**
   * Aggregate function-level scores up to the file level.
   * File score = max of all its function scores (one hot function is enough to include the file).
   */
  queryByFile(queryText: string): Map<string, number> {
    const docScores = this.query(queryText);
    const fileScores = new Map<string, number>();

    for (const doc of this.docs) {
      const score = docScores.get(doc.id) ?? 0;
      fileScores.set(doc.filePath, Math.max(fileScores.get(doc.filePath) ?? 0, score));
    }
    return fileScores;
  }

  /**
   * Return the top-scoring function document id within a file for a given query.
   * Returns null if no functions are indexed for this file.
   */
  topFunctionInFile(filePath: string, queryText: string): { id: string; score: number } | null {
    const docScores = this.query(queryText);
    let best: { id: string; score: number } | null = null;

    for (const doc of this.docs) {
      if (doc.filePath !== filePath || doc.id === filePath) continue; // skip file-level docs
      const score = docScores.get(doc.id) ?? 0;
      if (!best || score > best.score) best = { id: doc.id, score };
    }
    return best;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
