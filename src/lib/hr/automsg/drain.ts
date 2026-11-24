/**
 * HR automated messages: the cron side. Rows are enqueued in SQL
 * (migration 203); every pass here settles the stuck ones, expires the
 * stale ones, then hands the due rows to `processDue`. Both functions
 * never throw: a failure is logged once and the next pass picks the work
 * up (the claim in the engine keeps an overlapping run from double-sending).
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { createDinstarSmsSendPort } from './dinstar';
import { processDue } from './engine';
import type { EngineDeps } from './ports';
import { createRcsSendPort } from './rcs';
import { rcsSendConfig } from './rcs-config';
import { createHrSendPort } from './send';
import { smsSendConfig } from './sms-config';
import { PgAutoMsgStore } from './store';

export interface HrAutomsgDrainSummary {
  reviewed: number;
  expired: number;
  outcomes: Record<string, number>;
}

const DEFAULT_LIMIT = 100;
/** No further page starts after this; the next tick starts over. */
const PAGES_BUDGET_MS = 20_000;

export async function runHrAutomsgDrain(
  opts: { now?: Date; accountId?: string; limit?: number } = {}
): Promise<HrAutomsgDrainSummary | null> {
  try {
    const db = supabaseAdmin();
    const store = new PgAutoMsgStore(db);
    const now = opts.now ?? new Date();
    const reviewed = await store.reviewStuck(now);
    const expired = await store.expire(now);
    // Read at drain time: no RCS or SMS settings = those rows held, never
    // rerouted to another channel.
    const rcsCfg = rcsSendConfig();
    const smsCfg = smsSendConfig();
    const deps: EngineDeps = {
      store,
      sender: createHrSendPort(db),
      senders: {
        rcs: rcsCfg ? createRcsSendPort(db, rcsCfg) : null,
        sms: smsCfg ? createDinstarSmsSendPort(db, smsCfg) : null,
      },
      clock: { now: () => opts.now ?? new Date() },
    };
    const outcomes: Record<string, number> = {};
    // Page by page: rows still held stay due, so the first page alone
    // would starve whatever is behind a full page of them. A row is
    // processed once per drain (a failed one waits for the next).
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const started = Date.now();
    const seen = new Set<string>();
    for (;;) {
      const rows = await store.due(limit, opts.accountId, [...seen]);
      const fresh = rows.filter((r) => !seen.has(r.id));
      for (const r of fresh) seen.add(r.id);
      const counts = await processDue(fresh, deps);
      for (const [k, v] of Object.entries(counts))
        outcomes[k] = (outcomes[k] ?? 0) + (v ?? 0);
      if (fresh.length === 0 || rows.length < limit) break;
      if (Date.now() - started >= PAGES_BUDGET_MS) break;
    }
    return { reviewed, expired, outcomes };
  } catch (err) {
    console.error(
      '[hr-automsg] drain failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Enqueue the due nudges; the count of rows queued, null on failure. */
export async function runHrAutomsgNudges(
  now: Date = new Date()
): Promise<number | null> {
  try {
    return await new PgAutoMsgStore(supabaseAdmin()).enqueueNudges(now);
  } catch (err) {
    console.error(
      '[hr-automsg] nudges failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
