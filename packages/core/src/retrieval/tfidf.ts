/**
 * Pure TF-IDF implementation — zero dependencies, runs entirely in memory.
 *
 * Used to give semantic-ish relevance scores beyond simple keyword matching.
 * BM25-style term saturation (k1=1.5, b=0.75) for better ranking quality.
 */

const K1 = 1.5;  // term frequency saturation
const B = 0.75;  // length normalization factor

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase split
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
  id: string;       // file path
  text: string;     // combined text to index
}

export class TFIDFIndex {
  private docs: Array<{ id: string; tf: Map<string, number>; length: number }> = [];
  private df = new Map<string, number>();   // document frequency per term
  private avgLen = 0;

  build(documents: TFIDFDocument[]): void {
    this.docs = [];
    this.df = new Map();

    for (const doc of documents) {
      const tokens = tokenize(doc.text);
      const tf = termFrequency(tokens);
      this.docs.push({ id: doc.id, tf, length: tokens.length });

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
   * Returns a map of docId -> normalized score (0–1).
   */
  query(queryText: string): Map<string, number> {
    const qTokens = tokenize(queryText);
    const N = this.docs.length;
    if (N === 0 || qTokens.length === 0) return new Map();

    const rawScores = new Map<string, number>();

    for (const term of qTokens) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;

      // IDF with smoothing
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const doc of this.docs) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;

        // BM25 term score
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * doc.length / this.avgLen));
        const score = idf * norm;

        rawScores.set(doc.id, (rawScores.get(doc.id) ?? 0) + score);
      }
    }

    if (rawScores.size === 0) return rawScores;

    // Normalize to 0–1
    const max = Math.max(...rawScores.values());
    if (max === 0) return rawScores;

    const normalized = new Map<string, number>();
    for (const [id, score] of rawScores) {
      normalized.set(id, score / max);
    }
    return normalized;
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
