// ------------------------------------------------------------
// Account AI status for the Inbox's AI banner.
//
// It is the same for every conversation, so it is cached per account
// and reused across thread switches instead of hitting /api/ai/config
// every time the agent opens a chat. The Inbox warms it on mount
// (`warmAiAccountStatus`), so the first chat opened does not wait a
// round trip for it either; a banner that mounts while that read is in
// flight joins it.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------

export interface AiAccountStatus {
  autoReplyOn: boolean;
  /** `ai_configs.auto_resume_minutes`; null = never. */
  autoResumeMinutes: number | null;
}

export const AI_STATUS_OFF: AiAccountStatus = {
  autoReplyOn: false,
  autoResumeMinutes: null,
};

const statusCache = new Map<string, AiAccountStatus>();
const inflight = new Map<string, Promise<AiAccountStatus>>();

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Parse `/api/ai/config`'s answer into the banner's status. */
export function parseAiAccountStatus(j: unknown): AiAccountStatus {
  const o = (j ?? {}) as Record<string, unknown>;
  return {
    // AI auto-reply is "live" only when configured, the master switch
    // is on, and the inbound bot is enabled.
    autoReplyOn: !!(o.configured && o.is_active && o.auto_reply_enabled),
    autoResumeMinutes:
      typeof o.auto_resume_minutes === 'number' ? o.auto_resume_minutes : null,
  };
}

export function fetchAiAccountStatus(
  accountId: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(accountId);
  if (running) return running;
  const promise = (async () => {
    try {
      const res = await fetchImpl('/api/ai/config', { cache: 'no-store' });
      if (!res.ok) return AI_STATUS_OFF; // don't cache a transient failure
      const status = parseAiAccountStatus(await res.json());
      statusCache.set(accountId, status);
      return status;
    } catch {
      return AI_STATUS_OFF; // don't cache
    } finally {
      inflight.delete(accountId);
    }
  })();
  inflight.set(accountId, promise);
  return promise;
}

/** Read the account's AI status ahead of the first chat opened. */
export function warmAiAccountStatus(accountId: string | null): void {
  if (accountId) void fetchAiAccountStatus(accountId);
}

/** For tests only. */
export function resetAiAccountStatusForTests(): void {
  statusCache.clear();
  inflight.clear();
}
