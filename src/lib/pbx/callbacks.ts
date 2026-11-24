import type { SupabaseClient } from '@supabase/supabase-js';

import { closeSystemTasks } from '@/lib/tasks/system';
import type { SystemTaskSource } from '@/lib/tasks/types';

import { dncContactIds } from './calls';
import { pbxApiFor, PbxConnectionError, type PbxHandle } from './connection';
import { outboundCallsEnabled } from './outbound';
import { contactPhoneCandidates, normalizeRemoteNumber } from './phone';
import { YeastarError } from './yeastar';

/**
 * Dials the "Call me back" queue (callback_requests, migration 086).
 *
 * A pending request whose `not_before` has passed is dialled only
 * between 09:00 and 20:00 Dubai time, from its owner's extension: the
 * request's `assigned_to`, else the contact's owner, mapped to an
 * extension in that workspace (with no owner or no extension it is
 * `skipped`: nobody can place it). The PBX rings the owner first and then
 * the customer, whose recording notice plays before the owner is
 * connected. The number dialled is the dial route's normalised form; one
 * that is missing or an extension marks the request `failed`. A contact on
 * do-not-contact, or whose number another do-not-contact contact of the
 * workspace holds, is never dialled (`skipped`).
 *
 * The dial waits while that extension is not idle (or is known to be
 * unregistered or away), while the PBX is backing off, and while the
 * customer is being rung or was rung in the last `RING_GAP_MS`
 * (`ringClash`: another request of theirs, or any outbound call to their
 * number): the request stays pending, no attempt is spent, and
 * `not_before` moves it behind the rest of the queue. The clash is looked
 * for again after the claim, which is what stops two overlapping passes
 * that claim two requests of one customer: each claim is committed before
 * its own second look, so at least one sees the other and steps back.
 *
 * Each dial spends one attempt; the third failure marks it `failed`, and
 * the CALLBACK task stays open for a person either way. Every way back to
 * `pending` after an attempt waits (`retryNotBefore`). Only a refusal the
 * PBX stated counts as a failed dial (`dialRefused`): a timeout may have
 * rung the customer, so the request stays `dialing` for its 30012 or the
 * stale release.
 *
 * The call's 30012 settles a `dialing` request (`settleCallbackCall`,
 * from the event processor): answered closes it and its task.
 *
 * A request still `dialing` after `STALE_DIALING_MS` has lost its result:
 * the process died between the claim and the dial's answer, or the 30012
 * never arrived, and nothing else would ever move it. Every pass starts by
 * releasing those (`releaseStaleCallbacks`), outside call-back hours too,
 * because releasing never dials. A call still in `call_live` is left to
 * finish; one that has ended is settled as its 30012 would have been; no
 * trace of a call counts as one unanswered attempt. Each write re-checks
 * that the request is still `dialing` and still that old, so a late 30012
 * or an overlapping run wins.
 *
 * While calling from the CRM is switched off (`outboundCallsEnabled`)
 * nothing is dialled: every due pending request is marked `skipped`
 * (`outbound_calls_off`), at any hour, so its CALLBACK task stays with a
 * person and nothing stale is dialled once calling is switched on.
 * Releasing stuck requests still runs.
 */

export const CALLBACK_TIME_ZONE = 'Asia/Dubai';
export const CALLBACK_HOURS = { start: 9, end: 20 } as const;
export const MAX_CALLBACK_ATTEMPTS = 3;
/** A `dialing` request not updated for this long has lost its result. */
export const STALE_DIALING_MS = 30 * 60 * 1000;
/** A customer rung this recently is not rung again by the queue. */
export const RING_GAP_MS = 30 * 60 * 1000;
/** How long a request that could not be dialled now leaves the queue. */
export const CALLBACK_WAIT_MS = 5 * 60 * 1000;
/** The wait after each attempt; the last one is after the second. */
const RETRY_AFTER_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000];
/** Stale requests looked at in one pass; the rest wait for the next. */
const STALE_BATCH = 50;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** When a request back to pending after that many attempts is due again. */
export function retryNotBefore(attempts: number, nowMs: number): string {
  const step = Math.min(Math.max(attempts, 1), RETRY_AFTER_MS.length) - 1;
  return new Date(nowMs + RETRY_AFTER_MS[step]).toISOString();
}

/**
 * The PBX said no before anything rang: our own connection error, an error
 * code, or a failure before `call/dial` was reached (the token). Anything
 * else (a timeout, an unreadable answer) may have rung.
 */
function dialRefused(err: unknown): boolean {
  if (err instanceof PbxConnectionError) return true;
  return (
    err instanceof YeastarError &&
    (err.errcode !== null || err.endpoint !== 'call/dial')
  );
}

/**
 * When to try again because the customer is being rung, or was in the
 * last `RING_GAP_MS`; null when they may be rung now. A waiting request of
 * theirs does not count, or two waiting ones would block each other.
 */
async function ringClash(
  db: SupabaseClient,
  input: {
    requestId: string;
    accountId: string;
    contactId: unknown;
    number: string;
  },
  nowMs: number
): Promise<string | null> {
  const sibling = await db
    .from('callback_requests')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('status', 'dialing')
    .neq('id', input.requestId)
    .limit(1);
  if (sibling.error)
    throw new Error(`callback_requests read: ${sibling.error.message}`);
  if (((sibling.data ?? []) as unknown[]).length)
    return new Date(nowMs + CALLBACK_WAIT_MS).toISOString();
  const rung = await db
    .from('calls')
    .select('started_at')
    .eq('account_id', input.accountId)
    .eq('direction', 'outbound')
    .in('remote_number', contactPhoneCandidates(input.number))
    .gt('started_at', new Date(nowMs - RING_GAP_MS).toISOString())
    .order('started_at', { ascending: false })
    .limit(1);
  if (rung.error) throw new Error(`calls read: ${rung.error.message}`);
  const last = str(((rung.data ?? []) as Row[])[0]?.started_at);
  return last ? new Date(Date.parse(last) + RING_GAP_MS).toISOString() : null;
}

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: CALLBACK_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 09:00 up to (not including) 20:00 in Dubai. */
export function inCallbackHours(ms: number): boolean {
  const parts = hourFormat.formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return hour >= CALLBACK_HOURS.start && hour < CALLBACK_HOURS.end;
}

export interface DialCallbacksInput {
  db: SupabaseClient;
  now?: () => number;
  limit?: number;
  deadline?: number;
  apiFor?: (db: SupabaseClient, connectionId: string) => Promise<PbxHandle>;
}

export interface CallbacksSummary {
  outsideHours: boolean;
  dialled: number;
  skipped: number;
  /**
   * Left pending for later: owner busy, customer just rung, the PBX
   * backing off, or a refused dial with attempts left.
   */
  waiting: number;
  failed: number;
  /** Dialled with no clear answer: left `dialing` (see the header). */
  uncertain: number;
  /** Requests stuck `dialing` that were moved on (`STALE_DIALING_MS`). */
  released: number;
}

/** Whether the extension can take the call now, by its last known state. */
function extensionFree(
  presence: Row | null,
  registration: string | null
): boolean {
  if (registration && registration !== 'registered') return false;
  if (!presence || presence.call_state !== 'idle') return false;
  const status = str(presence.presence);
  return !status || status === 'available';
}

export async function dialDueCallbacks(
  input: DialCallbacksInput
): Promise<CallbacksSummary> {
  const { db, now = Date.now, limit = 20, deadline } = input;
  const apiFor = input.apiFor ?? ((d, id) => pbxApiFor(d, id, { now }));
  const summary: CallbacksSummary = {
    outsideHours: false,
    dialled: 0,
    skipped: 0,
    waiting: 0,
    failed: 0,
    uncertain: 0,
    released: 0,
  };
  // Before the hours check: releasing a stuck request never dials.
  summary.released = await releaseStaleCallbacks(db, now);
  const outbound = outboundCallsEnabled();
  if (outbound && !inCallbackHours(now())) {
    summary.outsideHours = true;
    return summary;
  }

  const nowIso = new Date(now()).toISOString();
  const { data, error } = await db
    .from('callback_requests')
    .select('id, account_id, contact_id, assigned_to, attempts')
    .eq('status', 'pending')
    .or(`not_before.is.null,not_before.lte.${nowIso}`)
    .order('not_before', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`callback_requests read failed: ${error.message}`);

  const handles = new Map<string, PbxHandle | null>();
  const busyExtensions = new Set<string>();

  const update = async (id: string, from: string, patch: Row) => {
    const r = await db
      .from('callback_requests')
      .update(patch)
      .eq('id', id)
      .eq('status', from)
      .select('id');
    if (r.error)
      throw new Error(`callback_requests update: ${r.error.message}`);
    return ((r.data ?? []) as unknown[]).length > 0;
  };
  /** Stays pending and lets the rest of the queue past. */
  const wait = async (id: string, until?: string) => {
    await update(id, 'pending', {
      not_before: until ?? new Date(now() + CALLBACK_WAIT_MS).toISOString(),
    });
    summary.waiting++;
  };

  for (const req of (data ?? []) as Row[]) {
    if (deadline !== undefined && now() >= deadline) break;
    const id = String(req.id);
    const accountId = String(req.account_id);
    const attempts = Number(req.attempts ?? 0);
    try {
      if (!outbound) {
        if (
          await update(id, 'pending', {
            status: 'skipped',
            last_error: 'outbound_calls_off',
          })
        )
          summary.skipped++;
        continue;
      }
      const c = await db
        .from('contacts')
        .select('phone, user_id')
        .eq('account_id', accountId)
        .eq('id', req.contact_id)
        .maybeSingle();
      if (c.error) throw new Error(`contacts read: ${c.error.message}`);
      const contact = c.data as Row | null;
      if (!contact) {
        await update(id, 'pending', {
          status: 'skipped',
          last_error: 'contact not found',
        });
        summary.skipped++;
        continue;
      }
      const remote = normalizeRemoteNumber(str(contact.phone));
      if (!remote || remote.internal) {
        await update(id, 'pending', {
          status: 'failed',
          last_error: remote
            ? 'the contact’s number is an extension'
            : 'the contact has no phone number',
        });
        summary.failed++;
        continue;
      }
      const number = remote.number;
      if (
        (await dncContactIds(db, accountId, number, [String(req.contact_id)]))
          .length
      ) {
        await update(id, 'pending', {
          status: 'skipped',
          last_error: 'do_not_contact',
        });
        summary.skipped++;
        continue;
      }
      const owner = str(req.assigned_to) ?? str(contact.user_id);
      const e = owner
        ? await db
            .from('pbx_extensions')
            .select('connection_id, extension, registration_state')
            .eq('account_id', accountId)
            .eq('user_id', owner)
            .limit(1)
        : null;
      if (e?.error) throw new Error(`pbx_extensions read: ${e.error.message}`);
      const ext = ((e?.data ?? []) as Row[])[0];
      if (!ext) {
        await update(id, 'pending', {
          status: 'skipped',
          last_error: owner
            ? 'the owner has no extension in this workspace'
            : 'no owner to call from',
        });
        summary.skipped++;
        continue;
      }
      const connectionId = String(ext.connection_id);
      const extension = String(ext.extension);
      const p = await db
        .from('pbx_presence')
        .select('presence, call_state')
        .eq('connection_id', connectionId)
        .eq('extension', extension)
        .maybeSingle();
      if (p.error) throw new Error(`pbx_presence read: ${p.error.message}`);
      const key = `${connectionId}:${extension}`;
      if (
        busyExtensions.has(key) ||
        !extensionFree(p.data as Row | null, str(ext.registration_state))
      ) {
        await wait(id);
        continue;
      }
      if (!handles.has(connectionId)) {
        try {
          handles.set(connectionId, await apiFor(db, connectionId));
        } catch (err) {
          if (!(err instanceof PbxConnectionError)) throw err;
          console.warn(`[pbx] callbacks: ${connectionId}: ${err.code}`);
          handles.set(connectionId, null);
        }
      }
      const handle = handles.get(connectionId);
      if (!handle) {
        await wait(id);
        continue;
      }
      const ring = {
        requestId: id,
        accountId,
        contactId: req.contact_id,
        number,
      };
      const clash = await ringClash(db, ring, now());
      if (clash) {
        await wait(id, clash);
        continue;
      }
      // Claim before dialling, so an overlapping run cannot ring twice.
      const spent = attempts + 1;
      if (
        !(await update(id, 'pending', {
          status: 'dialing',
          attempts: spent,
          last_error: null,
          // An earlier attempt's call must not settle this one.
          pbx_call_id: null,
        }))
      ) {
        continue;
      }
      // Again now the claim is committed: an overlapping pass may have
      // claimed another request of this customer meanwhile.
      const late = await ringClash(db, ring, now());
      if (late) {
        await update(id, 'dialing', {
          status: 'pending',
          attempts,
          not_before: late,
        });
        summary.waiting++;
        continue;
      }
      busyExtensions.add(key);
      let callId: string;
      try {
        ({ callId } = await handle.api.dial({
          caller: extension,
          callee: number,
        }));
      } catch (err) {
        if (!dialRefused(err)) {
          await update(id, 'dialing', {
            last_error: `dial not confirmed: ${message(err)}`,
          });
          summary.uncertain++;
          continue;
        }
        const back = backAfter(spent, now());
        await update(id, 'dialing', {
          ...back,
          last_error: `dial failed: ${message(err)}`,
        });
        if (back.status === 'failed') summary.failed++;
        else summary.waiting++;
        continue;
      }
      // The customer is being rung: an error saving the id must not undo
      // the claim (the stale release picks the request up).
      summary.dialled++;
      await update(id, 'dialing', { pbx_call_id: callId });
    } catch (err) {
      console.error(`[pbx] callback ${id}: ${message(err)}`);
    }
  }
  return summary;
}

/** Where an attempt that did not reach the customer leaves the request. */
function backAfter(attempts: number, nowMs: number): Row {
  return attempts >= MAX_CALLBACK_ATTEMPTS
    ? { status: 'failed' }
    : { status: 'pending', not_before: retryNotBefore(attempts, nowMs) };
}

/**
 * The 30012 of a call dialled for a call-back: answered → `done` and the
 * request's task closed; otherwise back to `pending` after a wait
 * (`retryNotBefore`), or `failed` once the attempts are spent. A call no `dialing` request placed is ignored.
 * Answers whether a request was settled.
 */
export async function settleCallbackCall(
  db: SupabaseClient,
  input: {
    accountId: string;
    pbxCallId: string;
    answered: boolean;
    status: string;
    /** Settle only a request not updated since then (the stale release). */
    staleBefore?: string;
    now?: () => number;
  }
): Promise<boolean> {
  const { now = Date.now } = input;
  const { data, error } = await db
    .from('callback_requests')
    .select('id, attempts, task_id')
    .eq('account_id', input.accountId)
    .eq('pbx_call_id', input.pbxCallId)
    .eq('status', 'dialing')
    .limit(1);
  if (error) throw new Error(`callback_requests read failed: ${error.message}`);
  const req = ((data ?? []) as Row[])[0];
  if (!req) return false;
  const attempts = Number(req.attempts ?? 0);
  const next = input.answered
    ? { status: 'done', last_error: null }
    : {
        ...backAfter(attempts, now()),
        last_error: `call ended ${input.status.toLowerCase()}`,
      };
  const move = db
    .from('callback_requests')
    .update(next)
    .eq('id', req.id)
    .eq('status', 'dialing');
  const moved = await (
    input.staleBefore ? move.lt('updated_at', input.staleBefore) : move
  ).select('id');
  if (moved.error) {
    throw new Error(`callback_requests update failed: ${moved.error.message}`);
  }
  if (!((moved.data ?? []) as unknown[]).length) return false;
  const taskId = str(req.task_id);
  if (!input.answered || !taskId) return true;
  const t = await db
    .from('tasks')
    .select('source, source_ref')
    .eq('account_id', input.accountId)
    .eq('id', taskId)
    .maybeSingle();
  if (t.error) throw new Error(`tasks read failed: ${t.error.message}`);
  const task = t.data as Row | null;
  const sourceRef = str(task?.source_ref);
  if (!task || !sourceRef) return true;
  await closeSystemTasks(db, {
    accountId: input.accountId,
    source: task.source as SystemTaskSource,
    sourceRef,
  });
  return true;
}

/**
 * Moves on every request stuck `dialing` (see the header) and answers how
 * many it moved. `now` is the clock, or the instant itself. A request that
 * changed since it was read is not counted: whoever changed it won.
 */
export async function releaseStaleCallbacks(
  db: SupabaseClient,
  now: number | (() => number)
): Promise<number> {
  const at = typeof now === 'function' ? now() : now;
  const staleBefore = new Date(at - STALE_DIALING_MS).toISOString();
  const { data, error } = await db
    .from('callback_requests')
    .select('id, account_id, attempts, pbx_call_id')
    .eq('status', 'dialing')
    .lt('updated_at', staleBefore)
    .order('updated_at', { ascending: true })
    .limit(STALE_BATCH);
  if (error) throw new Error(`callback_requests read failed: ${error.message}`);

  let released = 0;
  for (const req of (data ?? []) as Row[]) {
    const id = String(req.id);
    try {
      const accountId = String(req.account_id);
      const callId = str(req.pbx_call_id);
      if (callId) {
        // A call still on is not lost: its 30012 will settle the request.
        const live = await db
          .from('call_live')
          .select('pbx_call_id')
          .eq('account_id', accountId)
          .eq('pbx_call_id', callId)
          .limit(1);
        if (live.error)
          throw new Error(`call_live read: ${live.error.message}`);
        if (((live.data ?? []) as unknown[]).length) continue;
        // A call that ended without its 30012 reaching us: settle it from
        // the call's own record, the way that event would have.
        const ended = await db
          .from('calls')
          .select('status')
          .eq('account_id', accountId)
          .eq('pbx_call_id', callId)
          .not('ended_at', 'is', null)
          .limit(1);
        if (ended.error) throw new Error(`calls read: ${ended.error.message}`);
        const call = ((ended.data ?? []) as Row[])[0];
        if (call) {
          const status = str(call.status) ?? 'failed';
          const settled = await settleCallbackCall(db, {
            accountId,
            pbxCallId: callId,
            answered: status === 'answered',
            status: status.replace(/_/g, ' '),
            staleBefore,
            now: () => at,
          });
          if (settled) released++;
          continue;
        }
      }
      // No call id, or no trace of the call: one unanswered attempt.
      const attempts = Number(req.attempts ?? 0);
      const moved = await db
        .from('callback_requests')
        .update({
          ...backAfter(attempts, at),
          last_error: 'no result came back from the PBX',
        })
        .eq('id', id)
        .eq('status', 'dialing')
        .lt('updated_at', staleBefore)
        .select('id');
      if (moved.error) {
        throw new Error(`callback_requests update: ${moved.error.message}`);
      }
      if (((moved.data ?? []) as unknown[]).length) released++;
    } catch (err) {
      console.error(`[pbx] callback ${id} release: ${message(err)}`);
    }
  }
  return released;
}
