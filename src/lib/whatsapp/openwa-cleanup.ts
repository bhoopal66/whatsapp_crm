// ============================================================
// OpenWA session teardown, and the sweep for abandoned connects.
//
// Every OpenWA session runs a headless Chromium on the gateway host
// (300-500 MB each, on a small server), plus an operator key that can
// drive it. So a session the CRM no longer has a row for is not
// harmless: it is memory spent for nothing and a working key nobody
// will revoke. Both the Disconnect route and the sweep go through
// `teardownOpenWASession`, which says whether the gateway side is really
// gone, so neither has to guess.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  OpenWAError,
  deleteSession,
  findScopedKeyIds,
  getSession,
  logoutSession,
  openwaAdminApiKey,
  revokeKey,
} from './openwa-api';
import { promoteOldestToPrimary } from './personal-numbers';
import { waitingMessages } from './waiting-messages';

/**
 * A connect left unlinked this long is abandoned. Well past the dialog's
 * own 5-minute give-up, so a dialog still open (or its late-link check
 * on close) is never raced.
 */
export const OPENWA_ABANDONED_AFTER_MS = 30 * 60_000;

/**
 * How long a never-connected session may sit in a state that does not
 * say whether a phone is linked (`created`, `initializing`,
 * `authenticating`, `disconnected`, or a word this build doesn't know)
 * before the sweep stops waiting for it. A gateway restoring a saved
 * login after a restart reports `initializing`, and a linked phone
 * reconnecting reports `disconnected`, so those are never torn down on
 * one look. A real link is seen as `ready` by some probe within a day
 * (the health sweep looks every 5 minutes), so a session still unsure
 * after that is an abandoned one whose browser would otherwise run
 * for ever.
 */
export const OPENWA_UNSURE_GIVE_UP_MS = 24 * 60 * 60_000;

/** Statuses that say for certain no phone is linked to the session. */
const DEFINITELY_UNLINKED = new Set(['qr_ready', 'failed', 'action_required']);

/**
 * At most this many rows per sweep: a teardown is three or more gateway
 * calls, and the sweep shares the health tick's 60 s. The rest wait for
 * the next tick, five minutes later.
 *
 * Rows are taken least recently touched first (`updated_at`, which the
 * `set_updated_at` trigger stamps on every write), and a row the sweep
 * keeps is touched. So three rows whose teardown always fails go to the
 * back of the queue instead of holding the front forever.
 */
const SWEEP_LIMIT = 3;

/**
 * Log the phone out, delete the session and revoke its scoped keys.
 * Returns true only when the session and every key are known gone; never
 * throws. Logout is best effort (a session that never started answers
 * 400, and deleting the session ends it anyway); a 404 on the delete
 * means it was already gone.
 */
export async function teardownOpenWASession(args: {
  adminKey: string;
  sessionId: string;
  logPrefix: string;
}): Promise<boolean> {
  const { adminKey, sessionId, logPrefix } = args;
  let complete = true;

  // Logout first: deleting a linked session leaves the "linked device"
  // on the phone.
  await logoutSession({ adminKey, sessionId }).catch((e) =>
    console.warn(`${logPrefix} logout failed:`, errText(e))
  );
  try {
    await deleteSession({ adminKey, sessionId });
  } catch (e) {
    if (!(e instanceof OpenWAError && e.status === 404)) {
      complete = false;
      console.error(`${logPrefix} delete session failed:`, errText(e));
    }
  }
  let keyIds: string[] = [];
  try {
    keyIds = await findScopedKeyIds({ adminKey, sessionId });
  } catch (e) {
    complete = false;
    console.error(`${logPrefix} key lookup failed:`, errText(e));
  }
  for (const keyId of keyIds) {
    try {
      await revokeKey({ adminKey, keyId });
    } catch (e) {
      complete = false;
      console.error(`${logPrefix} revoke key failed:`, errText(e));
    }
  }
  return complete;
}

export interface AbandonedSweepSummary {
  found: number;
  removed: number;
  failed: number;
  /** Found linked after all: stamped connected, kept. */
  linked: number;
  /** Mid-link, or the gateway could not say: left for the next sweep. */
  kept: number;
}

/**
 * Remove OpenWA numbers whose connect was abandoned: never linked
 * (`connected_at IS NULL`) and created over 30 minutes ago, typically a
 * tab closed while the QR was showing. The row goes only after the
 * gateway side is confirmed gone; otherwise the next sweep retries,
 * because a row deleted first would leave nothing pointing at a still
 * running engine. A number that was ever connected is never touched.
 *
 * The gateway is asked first, because a teardown logs the phone out: a
 * phone that did link while nobody stamped it (the status route's write
 * failed, the health probes were inconclusive) is stamped connected
 * here, number and all, with no alert, exactly as a first link. A
 * session in a state that does not rule a link out (mid-link, starting
 * or restoring after a gateway restart, reconnecting), or one the
 * gateway could not report on, is left for the next sweep, for up to a
 * day. Only a definite not-linked answer (`qr_ready`, `failed`,
 * `action_required`), or a session the gateway no longer has (404), is
 * torn down.
 *
 * Service-role client (it reads every account). Skipped when
 * OPENWA_API_KEY is unset: without the admin key nothing can be torn
 * down, and deleting rows alone is exactly the orphaning this avoids.
 */
export async function sweepAbandonedOpenWASessions(
  admin: SupabaseClient,
  deps: { now?: () => Date } = {}
): Promise<AbandonedSweepSummary> {
  const summary: AbandonedSweepSummary = {
    found: 0,
    removed: 0,
    failed: 0,
    linked: 0,
    kept: 0,
  };
  const adminKey = openwaAdminApiKey();
  if (!adminKey) return summary;

  const now = deps.now ? deps.now() : new Date();
  const cutoff = new Date(
    now.getTime() - OPENWA_ABANDONED_AFTER_MS
  ).toISOString();
  const { data, error } = await admin
    .from('whatsapp_config')
    .select('id, account_id, phone_number_id, created_at')
    .eq('provider', 'openwa')
    .is('connected_at', null)
    .lt('created_at', cutoff)
    .order('updated_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT);
  if (error) {
    console.error('[openwa sweep] could not list abandoned connects:', error);
    return summary;
  }

  for (const row of (data ?? []) as Array<{
    id: string;
    account_id: string;
    phone_number_id: string | null;
    created_at?: string | null;
  }>) {
    summary.found++;
    const tag = `[openwa sweep] ${row.id} (account ${row.account_id})`;
    // Customer messages still waiting (264) would go with the row: leave
    // it for the next run, once they are processed.
    if ((await waitingMessages(admin, [row.id])) > 0) {
      summary.kept++;
      console.warn(`${tag}: customer messages still waiting; kept`);
      await touch(admin, row, tag);
      continue;
    }
    if (row.phone_number_id) {
      const sessionId = row.phone_number_id;
      const created = row.created_at ? Date.parse(row.created_at) : NaN;
      const ageMs = Number.isFinite(created) ? now.getTime() - created : null;
      const check = await checkSession(adminKey, sessionId, tag, ageMs);
      if (check.kind === 'linked') {
        if (await stampFirstLink(admin, row, check.phone, now, tag)) {
          summary.linked++;
        } else {
          summary.failed++;
        }
        continue;
      }
      if (check.kind === 'unsure') {
        summary.kept++;
        await touch(admin, row, tag);
        continue;
      }
      const gone = await teardownOpenWASession({
        adminKey,
        sessionId,
        logPrefix: tag,
      });
      if (!gone) {
        summary.failed++;
        console.warn(`${tag}: gateway cleanup incomplete; row kept for retry`);
        await touch(admin, row, tag);
        continue;
      }
    }
    // Still never connected: a phone that linked since the list was
    // read keeps its row (its session is gone, so it shows not live).
    const { data: deleted, error: deleteError } = await admin
      .from('whatsapp_config')
      .delete()
      .eq('id', row.id)
      .eq('account_id', row.account_id)
      .eq('provider', 'openwa')
      .is('connected_at', null)
      .select('id');
    if (deleteError) {
      summary.failed++;
      console.error(`${tag}: row delete failed:`, deleteError.message);
      continue;
    }
    if (deleted && deleted.length > 0) {
      summary.removed++;
      console.log(`${tag}: abandoned connect removed`);
      // It may have been the default (the first number is inserted so).
      await promoteOldestToPrimary(admin, row.account_id);
    }
  }
  return summary;
}

type SessionCheck =
  | { kind: 'linked'; phone: string | null }
  | { kind: 'unlinked' }
  | { kind: 'unsure' };

/**
 * Ask the gateway (admin key) whether the session linked after all.
 * `ageMs` is the row's age (null when unknown): it decides only when an
 * unsure state has lasted long enough to give up on (see
 * OPENWA_UNSURE_GIVE_UP_MS).
 */
async function checkSession(
  adminKey: string,
  sessionId: string,
  tag: string,
  ageMs: number | null
): Promise<SessionCheck> {
  try {
    const session = await getSession({ apiKey: adminKey, sessionId });
    if (session.status === 'ready') {
      return { kind: 'linked', phone: session.phone };
    }
    if (DEFINITELY_UNLINKED.has(session.status)) return { kind: 'unlinked' };
    if (ageMs !== null && ageMs >= OPENWA_UNSURE_GIVE_UP_MS) {
      console.log(
        `${tag}: still ${session.status} a day after connecting; removed`
      );
      return { kind: 'unlinked' };
    }
    console.log(`${tag}: ${session.status}, not known to be unlinked; kept`);
    return { kind: 'unsure' };
  } catch (e) {
    // The session is gone from the gateway: nothing can be linked, but
    // its scoped key may remain, so the teardown still runs.
    if (e instanceof OpenWAError && e.isSessionNotFound) {
      return { kind: 'unlinked' };
    }
    console.warn(`${tag}: session check failed; kept:`, errText(e));
    return { kind: 'unsure' };
  }
}

/**
 * Stamp a first link the way the status route would: connected, the
 * number, `connected_at`, and no alert (it was never up before). Only
 * while still never connected, so it never overwrites the route's own
 * write. True when the row is now linked (by us or by that write).
 */
async function stampFirstLink(
  admin: SupabaseClient,
  row: { id: string; account_id: string },
  phone: string | null,
  now: Date,
  tag: string
): Promise<boolean> {
  const patch: Record<string, unknown> = {
    status: 'connected',
    connected_at: now.toISOString(),
  };
  if (phone) patch.waba_id = phone;
  const { error } = await admin
    .from('whatsapp_config')
    .update(patch)
    .eq('id', row.id)
    .eq('account_id', row.account_id)
    .eq('provider', 'openwa')
    .is('connected_at', null);
  if (error) {
    console.error(`${tag}: first-link stamp failed:`, error.message);
    await touch(admin, row, tag);
    return false;
  }
  console.log(`${tag}: linked after all; stamped connected, no alert`);
  return true;
}

/**
 * Move a kept row to the back of the sweep's queue. The update itself is
 * the point: `set_updated_at` stamps `updated_at` on it. Best effort.
 */
async function touch(
  admin: SupabaseClient,
  row: { id: string; account_id: string },
  tag: string
): Promise<void> {
  const { error } = await admin
    .from('whatsapp_config')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('account_id', row.account_id)
    .is('connected_at', null);
  if (error) console.error(`${tag}: requeue failed:`, error.message);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
