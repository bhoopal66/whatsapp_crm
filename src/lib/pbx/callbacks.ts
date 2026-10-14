import type { SupabaseClient } from '@supabase/supabase-js';

import { closeSystemTasks } from '@/lib/tasks/system';
import type { SystemTaskSource } from '@/lib/tasks/types';

import { pbxApiFor, PbxConnectionError, type PbxHandle } from './connection';
import { digitsOnly } from './extensions';
import { outboundCallsEnabled } from './outbound';

/**
 * Dials the "Call me back" queue (callback_requests, migration 086).
 *
 * A pending request whose `not_before` has passed is dialled only
 * between 09:00 and 20:00 Dubai time, from its owner's extension: the
 * request's `assigned_to`, else the contact's owner, mapped to an
 * extension in that workspace. The PBX rings the owner first and then
 * the customer, whose recording notice plays before the owner is
 * connected. The dial waits while that extension is not idle (or is
 * known to be unregistered or away): the request stays pending, and no
 * attempt is spent. A contact on do-not-contact is never dialled
 * (`skipped`). Each dial spends one attempt; the third failure marks it
 * `failed`, and the CALLBACK task stays open for a person either way.
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
/** Stale requests looked at in one pass; the rest wait for the next. */
const STALE_BATCH = 50;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

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
  /** Left pending: owner busy, unmapped, or the PBX backing off. */
  waiting: number;
  failed: number;
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
        .select('phone, do_not_contact_at, user_id')
        .eq('account_id', accountId)
        .eq('id', req.contact_id)
        .maybeSingle();
      if (c.error) throw new Error(`contacts read: ${c.error.message}`);
      const contact = c.data as Row | null;
      if (!contact || contact.do_not_contact_at) {
        await update(id, 'pending', {
          status: 'skipped',
          last_error: contact ? 'do_not_contact' : 'contact not found',
        });
        summary.skipped++;
        continue;
      }
      const phone = digitsOnly(str(contact.phone) ?? '');
      if (!phone) {
        await update(id, 'pending', {
          status: 'failed',
          last_error: 'the contact has no phone number',
        });
        summary.failed++;
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
          last_error: owner
            ? 'the owner has no extension in this workspace'
            : 'no owner to call from',
        });
        summary.waiting++;
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
        summary.waiting++;
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
        summary.waiting++;
        continue;
      }
      // Claim before dialling, so an overlapping run cannot ring twice.
      const spent = attempts + 1;
      if (
        !(await update(id, 'pending', {
          status: 'dialing',
          attempts: spent,
          last_error: null,
        }))
      ) {
        continue;
      }
      busyExtensions.add(key);
      try {
        const { callId } = await handle.api.dial({
          caller: extension,
          callee: phone,
        });
        await update(id, 'dialing', { pbx_call_id: callId });
        summary.dialled++;
      } catch (err) {
        const gaveUp = spent >= MAX_CALLBACK_ATTEMPTS;
        await update(id, 'dialing', {
          status: gaveUp ? 'failed' : 'pending',
          last_error: `dial failed: ${message(err)}`,
        });
        if (gaveUp) summary.failed++;
        else summary.waiting++;
      }
    } catch (err) {
      console.error(`[pbx] callback ${id}: ${message(err)}`);
    }
  }
  return summary;
}

/**
 * The 30012 of a call dialled for a call-back: answered → `done` and the
 * request's task closed; otherwise back to `pending`, or `failed` once
 * the attempts are spent. A call no `dialing` request placed is ignored.
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
  }
): Promise<boolean> {
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
        status: attempts >= MAX_CALLBACK_ATTEMPTS ? 'failed' : 'pending',
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
          status: attempts >= MAX_CALLBACK_ATTEMPTS ? 'failed' : 'pending',
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
