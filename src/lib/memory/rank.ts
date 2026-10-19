/**
 * Ported from wacrm module 019b (CRM memory), reference package 2026-10-18.
 * Ranking of recalled memory (pure, no DB). Input: rows from PgMemoryStore.recall (plus optional embedding /
 * last_recalled_at). Output: the rows to put in the prompt, best first.
 *   base      weighted sum of the FTS rank normalised to 0..1 (divided by the batch maximum) and the cosine similarity
 *             (clamped to 0..1) when BOTH the query and the row carry an embedding of the same length; FTS only
 *             otherwise. Default weights 0.6 fts / 0.4 cosine (divided by their sum). A batch with no positive FTS
 *             rank (recall without a query) gives every row a neutral FTS component of 1.
 *   score     base x importance (1 + 0.2 x (importance - 3)) x recency (0.5 ^ (age days / 90), floor 0.3, age from
 *             lastRecalledAt ?? createdAt) x 0.7 if not verified.
 *   select    score desc, id asc; a row that is a near-duplicate of an already selected row (same normalised first 80
 *             chars, or token Jaccard >= 0.9) is dropped; stop at `limit` rows or at the first row whose
 *             ceil(chars / 4) tokens would exceed `tokenBudget` (rows are never cut).
 */
import { foldDigits } from './redact';

export interface RankRow {
  readonly id: string;
  readonly content: string;
  readonly importance: number;
  readonly trust: string;
  readonly createdAt: Date;
  readonly lastRecalledAt?: Date | null;
  /** ts_rank_cd from memory_recall_candidates (0 when recalled without a query). */
  readonly rank: number;
  readonly embedding?: readonly number[] | null;
}

export interface RankWeights {
  readonly fts: number;
  readonly cosine: number;
}

export interface RankOptions {
  readonly now: Date;
  readonly limit: number;
  readonly tokenBudget: number;
  readonly weights?: RankWeights;
  /** Embedding of the query; cosine is used only when this and the row's embedding are both present. */
  readonly queryEmbedding?: readonly number[] | null;
}

export interface Ranked<T extends RankRow> {
  readonly item: T;
  readonly score: number;
  readonly tokens: number;
}

export const DEFAULT_WEIGHTS: RankWeights = { fts: 0.6, cosine: 0.4 };
export const HALF_LIFE_DAYS = 90;
export const RECENCY_FLOOR = 0.3;
export const UNTRUSTED_FACTOR = 0.7;
export const DUP_PREFIX_CHARS = 80;
export const DUP_JACCARD = 0.9;
const DAY_MS = 86_400_000;

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

export function importanceFactor(importance: number): number {
  return 1 + 0.2 * (importance - 3);
}

export function recencyFactor(
  row: Pick<RankRow, 'createdAt' | 'lastRecalledAt'>,
  now: Date
): number {
  const at = (row.lastRecalledAt ?? row.createdAt).getTime();
  const ageDays = Math.max(0, (now.getTime() - at) / DAY_MS);
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
}

export function trustFactor(trust: string): number {
  return trust === 'verified' ? 1 : UNTRUSTED_FACTOR;
}

/** Cosine similarity clamped to 0..1; null when either vector is missing, empty, of a different length or zero. */
export function cosine01(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) return null;
  const c = dot / Math.sqrt(na * nb);
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
}

const normText = (s: string) =>
  foldDigits(s.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim();
const tokenSet = (norm: string) =>
  new Set(norm.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ''));

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function rankRecall<T extends RankRow>(
  rows: readonly T[],
  opts: RankOptions
): Ranked<T>[] {
  const nowMs = opts.now.getTime();
  if (!Number.isFinite(nowMs))
    throw new RangeError('rankRecall: now must be a valid Date');
  if (!Number.isInteger(opts.limit) || opts.limit < 0)
    throw new RangeError('rankRecall: limit must be an integer >= 0');
  if (!(opts.tokenBudget >= 0))
    throw new RangeError('rankRecall: tokenBudget must be >= 0');
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  if (
    !(w.fts >= 0) ||
    !(w.cosine >= 0) ||
    !(w.fts + w.cosine > 0) ||
    !Number.isFinite(w.fts + w.cosine)
  ) {
    throw new RangeError(
      'rankRecall: weights must be finite, >= 0 and not both 0'
    );
  }
  const wf = w.fts / (w.fts + w.cosine);
  const wc = w.cosine / (w.fts + w.cosine);

  const ftsOf = (r: RankRow) =>
    Number.isFinite(r.rank) && r.rank > 0 ? r.rank : 0;
  const maxFts = rows.reduce((m, r) => Math.max(m, ftsOf(r)), 0);

  const scored = rows.map((item) => {
    const fts = maxFts > 0 ? ftsOf(item) / maxFts : 1;
    const cos = cosine01(opts.queryEmbedding, item.embedding);
    const base = cos === null ? fts : wf * fts + wc * cos;
    let score = base * importanceFactor(item.importance);
    score *= recencyFactor(item, opts.now);
    score *= trustFactor(item.trust);
    const norm = normText(item.content);
    return {
      item,
      score,
      tokens: estimateTokens(item.content),
      prefix: norm.slice(0, DUP_PREFIX_CHARS),
      toks: tokenSet(norm),
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
  );

  const kept: typeof scored = [];
  let used = 0;
  for (const s of scored) {
    if (kept.length >= opts.limit) break;
    if (
      kept.some(
        (k) => k.prefix === s.prefix || jaccard(k.toks, s.toks) >= DUP_JACCARD
      )
    )
      continue;
    if (used + s.tokens > opts.tokenBudget) break;
    kept.push(s);
    used += s.tokens;
  }
  return kept.map(({ item, score, tokens }) => ({ item, score, tokens }));
}
