// ============================================================
// The Memory panel's pure helpers (019b / 019c), shared by the case
// page's Memory tab and the customer page's Memory card.
//
// Memory content is user text that has been through redaction (019b)
// or vault tokenisation (019c) on the server. The screen never renders
// it as HTML: memorySegments splits it into text, vault tokens
// (`[EID:vlt_…]`, revealable by a vault role) and redaction markers
// (`[CARD]`, `[PHONE:567]`, …), and the panel renders each segment as
// plain text or a chip.
// ============================================================

export type MemoryKind =
  'fact' | 'preference' | 'decision' | 'document' | 'summary';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'decision',
  'document',
  'summary',
];

/** The API's limit (after redaction); the form counts what was typed. */
export const MEMORY_CONTENT_MAX = 4000;
/** POST /forget's reason bound. */
export const FORGET_REASON_MAX = 1000;
/** POST /api/vault/reveal's reason bound. */
export const REVEAL_REASON_MAX = 500;
/** How long a revealed value stays on screen. */
export const REVEAL_VISIBLE_MS = 30_000;

export interface MemoryItemView {
  id: string;
  /** Null when the server sent a kind this screen does not know. */
  kind: MemoryKind | null;
  content: string;
  /** 1–5. */
  importance: number;
  /** Anything but an exact 'verified' is untrusted. */
  trust: 'verified' | 'untrusted';
  sourceType: string | null;
  createdBy: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  /** Search results only. */
  rank: number | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const isoOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && !Number.isNaN(new Date(s).getTime()) ? s : null;
};

/**
 * `{ items }` from GET …/memory, with or without q. Search results carry
 * `rank` and leave some list fields out, so every field but id and
 * content is optional; an entry without those two is dropped.
 */
export function parseMemoryItems(json: unknown): MemoryItemView[] {
  const items = obj(json)?.items;
  if (!Array.isArray(items)) return [];
  const out: MemoryItemView[] = [];
  for (const raw of items) {
    const o = obj(raw);
    const id = str(o?.id);
    if (!o || id === null || typeof o.content !== 'string') continue;
    const imp = o.importance;
    out.push({
      id,
      kind: MEMORY_KINDS.includes(o.kind as MemoryKind)
        ? (o.kind as MemoryKind)
        : null,
      content: o.content,
      importance:
        typeof imp === 'number' && Number.isFinite(imp)
          ? Math.min(5, Math.max(1, Math.round(imp)))
          : 3,
      trust: o.trust === 'verified' ? 'verified' : 'untrusted',
      sourceType: str(o.sourceType),
      createdBy: str(o.createdBy),
      createdAt: isoOrNull(o.createdAt),
      expiresAt: isoOrNull(o.expiresAt),
      rank:
        typeof o.rank === 'number' && Number.isFinite(o.rank) ? o.rank : null,
    });
  }
  return out;
}

export type VaultTokenKind =
  'EID' | 'IBAN' | 'PASSPORT' | 'PHONE' | 'ACCOUNT' | 'TRADE_LICENCE';

export type RedactionKind =
  'EMAIL' | 'CARD' | 'OTP' | 'IBAN' | 'EID' | 'ACCT' | 'PASSPORT' | 'PHONE';

export type MemorySegment =
  | { type: 'text'; text: string }
  /** `token` is the bare `vlt_…` id POST /api/vault/reveal takes. */
  | { type: 'token'; kind: VaultTokenKind; token: string }
  /** `last` is the kept tail of a redacted phone (`[PHONE:567]`). */
  | { type: 'redaction'; kind: RedactionKind; last: string | null };

// One pass, three alternatives: a vault token, a bare redaction marker,
// a phone marker with its kept digits.
const SEGMENT_RE =
  /\[(EID|IBAN|PASSPORT|PHONE|ACCOUNT|TRADE_LICENCE):(vlt_[ghjkmnpqrstvwxyz]{26})\]|\[(EMAIL|CARD|OTP|IBAN|EID|ACCT|PASSPORT)\]|\[PHONE:(\d{1,4})\]/g;

/** Content split into what the panel renders: text, token chips, redaction chips. */
export function memorySegments(content: string): MemorySegment[] {
  const out: MemorySegment[] = [];
  let at = 0;
  for (const m of content.matchAll(SEGMENT_RE)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ type: 'text', text: content.slice(at, start) });
    if (m[1] !== undefined && m[2] !== undefined)
      out.push({ type: 'token', kind: m[1] as VaultTokenKind, token: m[2] });
    else if (m[3] !== undefined)
      out.push({ type: 'redaction', kind: m[3] as RedactionKind, last: null });
    else out.push({ type: 'redaction', kind: 'PHONE', last: m[4] ?? null });
    at = start + m[0].length;
  }
  if (at < content.length) out.push({ type: 'text', text: content.slice(at) });
  return out;
}

/** Characters as the server counts them (code points, not UTF-16 units). */
export const charCount = (s: string): number => [...s].length;

const REFUSALS: Record<string, string> = {
  TOKENIZE_FAILED: 'tokenizeFailed',
  EMPTY: 'empty',
  TOO_LONG: 'tooLong',
  SUPERSEDE_VERIFIED: 'supersedeVerified',
  SCOPE_INVALID: 'scopeInvalid',
  REDACTION_REFUSED: 'redactionRefused',
};

/** The `Memory.refusals.*` key for a POST's 422 code. */
export function refusalMessageKey(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(REFUSALS, code)
    ? REFUSALS[code]!
    : 'unknown';
}

/** The `Memory.errors.*` key for a failed POST …/memory. */
export function saveErrorKey(status: number, code: unknown): string {
  if (status === 422) return `refusals.${refusalMessageKey(code)}`;
  if (status === 403) return 'errors.forbidden';
  if (status === 404) return 'errors.notFound';
  if (status === 400) return 'errors.invalid';
  return 'errors.saveFailed';
}

/** The `Memory.reveal.errors.*` key for a failed POST /api/vault/reveal. */
export function revealErrorKey(status: number, code: unknown): string {
  if (code === 'DENIED' || status === 403) return 'denied';
  if (code === 'NOT_FOUND' || status === 404) return 'notFound';
  if (code === 'RATE_LIMITED' || status === 429) return 'rateLimited';
  if (code === 'DECRYPT_FAILED' || status === 409) return 'decryptFailed';
  if (code === 'VAULT_NOT_CONFIGURED' || status === 503) return 'notConfigured';
  // The token is well-formed and the reason's length checked before
  // sending, so a 400 is the reason refused for carrying an identifier.
  if (status === 400) return 'reasonRefused';
  return 'failed';
}

/** GET /api/vault's answer: may this caller reveal tokens? */
export function canRevealFrom(json: unknown): boolean {
  const o = obj(json);
  return o?.configured === true && str(obj(o.overview)?.myRole) !== null;
}

/** The list / search URL for one page. */
export function memoryListUrl(
  apiBase: string,
  opts: { q?: string; before?: string | null; limit: number }
): string {
  const p = new URLSearchParams();
  const q = opts.q?.trim();
  if (q) p.set('q', q);
  else if (opts.before) p.set('before', opts.before);
  p.set('limit', String(opts.limit));
  return `${apiBase}?${p.toString()}`;
}

/** The `before` cursor for the next page: the oldest item's time. */
export function nextBefore(items: readonly MemoryItemView[]): string | null {
  let oldest: string | null = null;
  for (const it of items)
    if (
      it.createdAt !== null &&
      (oldest === null ||
        new Date(it.createdAt).getTime() < new Date(oldest).getTime())
    )
      oldest = it.createdAt;
  return oldest;
}

/** Append a page, dropping ids already shown (same-instant boundary rows). */
export function appendPage(
  shown: readonly MemoryItemView[],
  page: readonly MemoryItemView[]
): MemoryItemView[] {
  const seen = new Set(shown.map((i) => i.id));
  return [...shown, ...page.filter((i) => !seen.has(i.id))];
}
