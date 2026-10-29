// Browser side of Translate: POST /api/ai/translate/message (a thread
// message into English) and POST /api/ai/translate (a draft into Arabic).
// Both answer { text } or { error, code }.

export type TranslateResult =
  | { ok: true; text: string }
  | {
      ok: false;
      /** The route's `code` ('ai_not_configured', …), 'network', 'empty', or null. */
      code: string | null;
      /** The route's own wording, when it sent one. */
      error: string | null;
    };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// This session's translations of thread messages, keyed by message id and
// the text translated, so an edited message is translated afresh. The
// server keeps its own copy (message_translations); this one only spares
// the round trip when a bubble remounts.
const CACHE_MAX = 500;
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<TranslateResult>>();

const cacheKey = (messageId: string, source: string) =>
  `${messageId}\u0000${source}`;

export function cachedMessageTranslation(
  messageId: string,
  source: string
): string | null {
  return cache.get(cacheKey(messageId, source)) ?? null;
}

async function post(
  url: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<TranslateResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: 'network', error: null };
  }
  const data: unknown = await res.json().catch(() => null);
  const obj =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (!res.ok) {
    return {
      ok: false,
      code: typeof obj.code === 'string' ? obj.code : null,
      error: typeof obj.error === 'string' ? obj.error : null,
    };
  }
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (!text) return { ok: false, code: 'empty', error: null };
  return { ok: true, text };
}

/**
 * Translate a thread message into English. `source` is the text on screen;
 * the server translates the stored message, never text from the browser.
 */
export function translateMessage(
  messageId: string,
  source: string,
  fetchImpl: FetchLike = fetch
): Promise<TranslateResult> {
  const key = cacheKey(messageId, source);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve({ ok: true, text: hit });
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = post(
    '/api/ai/translate/message',
    { message_id: messageId },
    fetchImpl
  )
    .then((result) => {
      if (result.ok) {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, result.text);
      }
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Translate the composer's draft into Arabic. Nothing is stored. */
export function translateDraft(
  text: string,
  conversationId: string,
  fetchImpl: FetchLike = fetch
): Promise<TranslateResult> {
  return post(
    '/api/ai/translate',
    { text, conversation_id: conversationId, target: 'ar' },
    fetchImpl
  );
}

/** Test seam: forget every cached and pending translation. */
export function resetTranslationCache(): void {
  cache.clear();
  inFlight.clear();
}
