// ============================================================
// "Check before sending" (migration 149) as the browser sees it: the
// composer's decision whether to ask, the request with its own
// timeout, and the shapes the dialog and the Settings stats read.
//
// Dependency-free on purpose. The composer and the Settings panel are
// client components, and a client import graph that reaches a server
// module (lib/insights/compose-check.ts reaches the admin client and
// TypeSafe) breaks the production build without typecheck noticing.
// So the code list is restated here; compose-check-view.test.ts reads
// the server module's list to keep the two equal.
// ============================================================

/** The warning codes, most serious first: the order the dialog lists them. */
export const COMPOSE_CHECK_CODES_BY_SEVERITY = [
  'secrets',
  'promise',
  'terms',
  'regulator_claim',
  'non_partner_bank',
  'cold_pitch',
  'tone',
] as const;
export type ComposeCheckCode = (typeof COMPOSE_CHECK_CODES_BY_SEVERITY)[number];

export type ComposeCheckMode = 'off' | 'warn';

/** A draft shorter than this (trimmed) is sent without asking. */
export const COMPOSE_CHECK_CLIENT_MIN_CHARS = 12;

/** The composer waits at most this long for an answer, then sends. */
export const COMPOSE_CHECK_CLIENT_TIMEOUT_MS = 2500;

const RANK = new Map<string, number>(
  COMPOSE_CHECK_CODES_BY_SEVERITY.map((code, i) => [code, i])
);

export function isComposeCheckCode(v: unknown): v is ComposeCheckCode {
  return typeof v === 'string' && RANK.has(v);
}

/** Should this send be checked first? Only free text, mode on, long enough. */
export function shouldCheckDraft(
  mode: ComposeCheckMode | null | undefined,
  text: string
): boolean {
  return (
    mode === 'warn' && text.trim().length >= COMPOSE_CHECK_CLIENT_MIN_CHARS
  );
}

/** Known codes only, each once, most serious first. */
export function orderWarnings(codes: readonly unknown[]): ComposeCheckCode[] {
  const seen = new Set<ComposeCheckCode>();
  for (const code of codes) if (isComposeCheckCode(code)) seen.add(code);
  return [...seen].sort((a, b) => RANK.get(a)! - RANK.get(b)!);
}

/** The secrets warning is the one that must never be sent as is. */
export function warningTone(code: ComposeCheckCode): 'destructive' | 'warning' {
  return code === 'secrets' ? 'destructive' : 'warning';
}

export type ComposeCheckDecision =
  /** Send now: no warnings, or the check failed (fail open). */
  | { kind: 'send' }
  /** Ask the agent first. */
  | { kind: 'review'; warnings: ComposeCheckCode[]; eventId: string | null }
  /** The caller gave up (the chat changed): do nothing. */
  | { kind: 'cancelled' };

const SEND: ComposeCheckDecision = { kind: 'send' };

type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, 'ok' | 'json'>>;

/**
 * Ask the server about a draft. Never throws and never holds a message
 * back: an error, a non-2xx answer (429 included), a malformed body or
 * no answer within `timeoutMs` all mean "send". Only an abort of the
 * caller's own `signal` answers `cancelled`.
 */
export async function requestComposeCheck({
  conversationId,
  text,
  signal,
  timeoutMs = COMPOSE_CHECK_CLIENT_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  conversationId: string;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ComposeCheckDecision> {
  if (signal?.aborted) return { kind: 'cancelled' };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The body read is inside the race too: a stalled body is a timeout.
    const json = await new Promise<unknown>((resolve, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error('aborted'))
      );
      fetchImpl('/api/insights/compose-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, text }),
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then(resolve, reject);
    });
    if (signal?.aborted) return { kind: 'cancelled' };
    const body = (json ?? {}) as { warnings?: unknown; eventId?: unknown };
    if (!Array.isArray(body.warnings)) return SEND;
    const warnings = orderWarnings(
      body.warnings.map((w) => (w as { code?: unknown } | null)?.code)
    );
    if (warnings.length === 0) return SEND;
    return {
      kind: 'review',
      warnings,
      eventId: typeof body.eventId === 'string' ? body.eventId : null,
    };
  } catch {
    return signal?.aborted ? { kind: 'cancelled' } : SEND;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Record what the agent chose. Silent: a failure changes nothing. */
export function reportComposeCheckOutcome(
  eventId: string | null,
  outcome: 'sent_anyway' | 'edited',
  fetchImpl: FetchLike = fetch
): void {
  if (!eventId) return;
  try {
    void fetchImpl(
      `/api/insights/compose-check/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      }
    ).catch(() => {});
  } catch {
    // fetch itself threw synchronously: nothing to do.
  }
}

export interface ComposeCheckStats {
  days: number;
  total: number;
  sentAnyway: number;
  edited: number;
  pending: number;
  byCode: Partial<Record<ComposeCheckCode, number>>;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** The stats route's answer, tolerantly; null when it is not one. */
export function parseComposeCheckStats(
  json: unknown
): ComposeCheckStats | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.total !== 'number') return null;
  const byCode: Partial<Record<ComposeCheckCode, number>> = {};
  if (o.byCode && typeof o.byCode === 'object')
    for (const [code, n] of Object.entries(o.byCode as object))
      if (isComposeCheckCode(code)) byCode[code] = count(n);
  return {
    days: count(o.days),
    total: count(o.total),
    sentAnyway: count(o.sentAnyway),
    edited: count(o.edited),
    pending: count(o.pending),
    byCode,
  };
}

/** The `n` codes seen most, ties by severity; codes never seen are left out. */
export function topCodes(
  byCode: Partial<Record<ComposeCheckCode, number>>,
  n = 3
): { code: ComposeCheckCode; count: number }[] {
  return COMPOSE_CHECK_CODES_BY_SEVERITY.map((code) => ({
    code,
    count: byCode[code] ?? 0,
  }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || RANK.get(a.code)! - RANK.get(b.code)!)
    .slice(0, n);
}
