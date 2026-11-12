/**
 * Ported from wacrm module 022a (second brain): the Embedder port's
 * deterministic implementation, and the only one.
 * HashingEmbedder - UNVERIFIED for real semantic quality: feature hashing of
 * lower-cased word tokens (letters and digits, any script) and of their
 * character trigrams into `dim` (default 256) buckets with a hash-derived
 * sign, then L2 normalised. Same text -> same vector on every machine; texts
 * sharing words score higher than texts that share none. It knows nothing of
 * synonyms or meaning; a real embedding model would replace it behind the
 * same port (and under a different `model`, so vectors are never mixed).
 */
import type { Embedder } from './ports';

/** FNV-1a 32-bit over the UTF-16 units of s. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function l2normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

/** Cosine similarity; 0 when either vector is zero or the dims differ. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export class HashingEmbedder implements Embedder {
  readonly model: string;
  constructor(readonly dim: number = 256) {
    this.model = `hashing-v1-${dim}`;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const k = h % this.dim;
      v[k] = (v[k] ?? 0) + (h & 0x80000000 ? -1 : 1) * weight;
    };
    for (const t of tokens(text)) {
      add(`w:${t}`, 1);
      if (t.length > 3)
        for (let i = 0; i + 3 <= t.length; i++)
          add(`g:${t.slice(i, i + 3)}`, 0.25);
    }
    return l2normalise(v);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}
