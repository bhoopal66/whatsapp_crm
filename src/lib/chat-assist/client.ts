/**
 * The panel's side of a suggested action: what one click does. Pure apart
 * from the injected `fetch`, so the order is tested.
 *
 *   confirm  1. POST /api/assist/pending/[id] { decision: 'confirm', nonce }
 *               (the person's session confirms; the nonce came on the card)
 *            2. only if that succeeded: POST /api/assist/chat/[chat]/run
 *               { pendingId, tool, args } exactly as the card carried them
 *   dismiss  POST /api/assist/pending/[id] { decision: 'deny', nonce }:
 *            frees one of the person's five open pending slots.
 *
 * Nothing in the panel runs an action any other way.
 */
import type { ActionCard } from './router';

export type PendingCard = Extract<ActionCard, { status: 'pending' }>;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CardOutcome =
  | { ok: true }
  /** `code` is the server's refusal (EXPIRED, NOT_FOUND, refused, …). */
  | { ok: false; step: 'confirm' | 'run'; code: string };

async function post(fetcher: Fetch, url: string, body: unknown) {
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      code?: unknown;
      error?: unknown;
    };
    const code =
      typeof data.code === 'string'
        ? data.code
        : typeof data.error === 'string'
          ? data.error
          : `http_${res.status}`;
    return { ok: res.ok, code };
  } catch {
    return { ok: false, code: 'network' };
  }
}

export async function confirmCard(
  conversationId: string,
  card: PendingCard,
  fetcher: Fetch = fetch
): Promise<CardOutcome> {
  const confirmed = await post(
    fetcher,
    `/api/assist/pending/${card.pendingId}`,
    { decision: 'confirm', nonce: card.nonce }
  );
  if (!confirmed.ok)
    return { ok: false, step: 'confirm', code: confirmed.code };
  const ran = await post(fetcher, `/api/assist/chat/${conversationId}/run`, {
    pendingId: card.pendingId,
    tool: card.tool,
    args: card.args,
  });
  return ran.ok ? { ok: true } : { ok: false, step: 'run', code: ran.code };
}

/** Best effort: a dismissed card that cannot be denied simply expires. */
export async function dismissCard(
  card: PendingCard,
  fetcher: Fetch = fetch
): Promise<void> {
  await post(fetcher, `/api/assist/pending/${card.pendingId}`, {
    decision: 'deny',
    nonce: card.nonce,
  });
}

/** Which catalogue key words a failed card (`ChatAssist.cardErrors`). */
export function cardErrorKey(
  code: string
):
  | 'expired'
  | 'notFound'
  | 'refused'
  | 'changed'
  | 'invalid'
  | 'busy'
  | 'failed' {
  switch (code) {
    case 'EXPIRED':
      return 'expired';
    case 'NOT_FOUND':
    case 'not_found':
      return 'notFound';
    case 'refused':
    case 'WRONG_USER':
      return 'refused';
    case 'changed':
    case 'NOT_PENDING':
    case 'HASH_MISMATCH':
      return 'changed';
    case 'invalid':
    case 'bad_args':
      return 'invalid';
    case 'RATE_LIMITED':
    case 'PENDING_CAP':
    case 'LOOP_REPEAT':
    case 'CALL_CAP':
      return 'busy';
    default:
      return 'failed';
  }
}
