// ============================================================
// Meetings API — server-side helpers shared by the route handlers.
//
// Access is always judged through the caller's RLS client (the
// meetings / meeting_participants SELECT policies are
// `meeting_can_view`). The service role (`supabaseAdmin`) only writes
// meeting_participants, which have no client write policy, and only
// after one of these reads has found the caller's row.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  getCurrentAccount,
  type AccountContext,
} from '@/lib/auth/account';
import { canUseMeetings } from '@/lib/auth/roles';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

import { isMeetingsConfigured, SfuError } from './sfu';
import {
  MEETING_COLUMNS,
  PARTICIPANT_COLUMNS,
  type MeetingRow,
  type ParticipantRow,
} from './types';

export const STAFF_ONLY = 'Video meetings are for staff only';
/** POST /api/meetings below team leader (migration 111). */
export const MEETING_CREATORS_ONLY =
  'Only team leaders and admins can create meetings';

/**
 * The caller's context, refused for a bank guest (staff only). A guest
 * usually never reaches the role check: `current_account_id()` is NULL
 * for them, so the accounts read in `getCurrentAccount` finds nothing
 * and it refuses with "Profile is not linked to an account", which
 * reads as a broken login. That refusal is reworded here; every other
 * one (deactivated, a failed read) keeps its own message.
 */
export async function requireMeetingsUser(): Promise<AccountContext> {
  let ctx: AccountContext;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    if (
      err instanceof ForbiddenError &&
      err.message === 'Profile is not linked to an account'
    ) {
      throw new ForbiddenError(STAFF_ONLY);
    }
    throw err;
  }
  if (!canUseMeetings(ctx.role)) throw new ForbiddenError(STAFF_ONLY);
  return ctx;
}

let _admin: SupabaseClient | null = null;
/** Lazy service-role client (same shape as lib/flows/admin-client.ts). */
export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _admin;
}

export type Params = { params: Promise<{ id: string }> };

export const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, { status });

export function notConfiguredResponse(): NextResponse | null {
  return isMeetingsConfigured()
    ? null
    : jsonError('meetings_not_configured', 503);
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

/** A failed SFU call. Cloudflare's own status is not passed through:
 *  its 401 would read as the caller's. */
export function sfuErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof SfuError)) return null;
  // 410: the Cloudflare session is gone already — the seat was cut by a
  // leave, a removal or the end racing this call. Expected, not a fault.
  if (err.status === 410) {
    return jsonError('The video session has already ended', 410);
  }
  console.error('[meetings] sfu call failed', err.status, err.code);
  if (err.code === 'not_configured') {
    return jsonError('meetings_not_configured', 503);
  }
  return err.isTimeout
    ? jsonError('The video service did not respond', 504)
    : jsonError('The video service refused the request', 502);
}

export function meetingDbErrorResponse(
  error: { code?: string; message?: string },
  fallback: string
): NextResponse {
  switch (error.code) {
    case '42501':
      return jsonError("You can't make that change to this meeting", 403);
    case '23514':
    case 'P0001':
      return jsonError(error.message || fallback, 400);
    case '23503':
      return jsonError('A person or meeting was not found', 400);
    case '22P02':
    case '22007':
    case '22008':
      return jsonError('Invalid value', 400);
    default:
      console.error('[meetings]', fallback, error);
      return jsonError(fallback, 500);
  }
}

type Db = SupabaseClient;

/** The meeting, if the caller's RLS lets them see it. */
export async function loadMeeting(
  supabase: Db,
  accountId: string,
  id: string
): Promise<{ meeting: MeetingRow | null; error: unknown }> {
  const { data, error } = await supabase
    .from('meetings')
    .select(MEETING_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  return { meeting: (data as MeetingRow | null) ?? null, error };
}

/** `meeting_can_view` / `meeting_can_manage` for the caller. `error` is
 *  a failed call, which the route answers with `readErrorResponse`: read
 *  as `false` it became a 404 "not found" or a 403 on a blip. */
export async function rpcFlag(
  supabase: Db,
  fn: 'meeting_can_view' | 'meeting_can_manage',
  meetingId: string
): Promise<{ allowed: boolean; error: unknown }> {
  const { data, error } = await supabase.rpc(fn, { p_meeting: meetingId });
  if (error) return { allowed: false, error };
  return { allowed: data === true, error: null };
}

/** A read that failed (not a row that is missing): 503, so the client
 *  keeps its seat and retries instead of reading it as "you left". */
export function readErrorResponse(error: unknown): NextResponse {
  console.error('[meetings] read failed', error);
  return jsonError('temporarily_unavailable', 503);
}

/** The caller's own participant row in this meeting, open or not.
 *  `error` is a failed read; a missing row is `participant: null`. */
export async function loadOwnParticipant(
  supabase: Db,
  ctx: { userId: string },
  meetingId: string,
  participantId: string
): Promise<{ participant: ParticipantRow | null; error: unknown }> {
  const { data, error } = await supabase
    .from('meeting_participants')
    .select(PARTICIPANT_COLUMNS)
    .eq('id', participantId)
    .eq('meeting_id', meetingId)
    .eq('user_id', ctx.userId)
    .maybeSingle();
  return { participant: (data as ParticipantRow | null) ?? null, error };
}
