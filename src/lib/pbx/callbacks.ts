import type { SupabaseClient } from '@supabase/supabase-js';

import { closeSystemTasks } from '@/lib/tasks/system';
import type { SystemTaskSource } from '@/lib/tasks/types';

import { pbxApiFor, PbxConnectionError, type PbxHandle } from './connection';
import { digitsOnly } from './extensions';

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
 */

export const CALLBACK_TIME_ZONE = 'Asia/Dubai';
export const CALLBACK_HOURS = { start: 9, end: 20 } as const;
export const MAX_CALLBACK_ATTEMPTS = 3;

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
  };
  if (!inCallbackHours(now())) {
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
 */
export async function settleCallbackCall(
  db: SupabaseClient,
  input: {
    accountId: string;
    pbxCallId: string;
    answered: boolean;
    status: string;
  }
): Promise<void> {
  const { data, error } = await db
    .from('callback_requests')
    .select('id, attempts, task_id')
    .eq('account_id', input.accountId)
    .eq('pbx_call_id', input.pbxCallId)
    .eq('status', 'dialing')
    .limit(1);
  if (error) throw new Error(`callback_requests read failed: ${error.message}`);
  const req = ((data ?? []) as Row[])[0];
  if (!req) return;
  const attempts = Number(req.attempts ?? 0);
  const next = input.answered
    ? { status: 'done', last_error: null }
    : {
        status: attempts >= MAX_CALLBACK_ATTEMPTS ? 'failed' : 'pending',
        last_error: `call ended ${input.status.toLowerCase()}`,
      };
  const moved = await db
    .from('callback_requests')
    .update(next)
    .eq('id', req.id)
    .eq('status', 'dialing')
    .select('id');
  if (moved.error) {
    throw new Error(`callback_requests update failed: ${moved.error.message}`);
  }
  if (!input.answered || !((moved.data ?? []) as unknown[]).length) return;
  const taskId = str(req.task_id);
  if (!taskId) return;
  const t = await db
    .from('tasks')
    .select('source, source_ref')
    .eq('account_id', input.accountId)
    .eq('id', taskId)
    .maybeSingle();
  if (t.error) throw new Error(`tasks read failed: ${t.error.message}`);
  const task = t.data as Row | null;
  const sourceRef = str(task?.source_ref);
  if (!task || !sourceRef) return;
  await closeSystemTasks(db, {
    accountId: input.accountId,
    source: task.source as SystemTaskSource,
    sourceRef,
  });
}
