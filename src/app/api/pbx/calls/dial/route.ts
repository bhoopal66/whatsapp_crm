// ============================================================
// POST /api/pbx/calls/dial — click-to-call (module 015, migration 089).
// { contactId? | number?, conversationId?, dealId? | participantId?,
//   overrideReason? } → { pbxCallId }
//
// The PBX rings the caller's OWN extension (pbx_my_extension(), on the
// caller's client) and then the customer: an extension in the body is
// never read (C-7). The callee is a contact the caller can see, the
// contact of a conversation or deal they can see, or any typed number,
// an extension or an outside one (resolveCallee).
// A do-not-contact customer is refused (409, code do_not_contact)
// unless an owner or admin sends overrideReason, which is written to
// pbx_audit before the PBX is asked. No calls row is made here: the
// event processor creates it from the PBX's events. Agent+.
//
// participantId (alone) calls someone in a deal room (plan 015 §7.2):
// the caller must be able to post in that room (deal_room_can_post,
// asked as the caller, before anything about the person is judged),
// the number is read on the service role inside the caller's account
// (never taken from the request), and a bank officer only while their
// bank's guests are on (lib/deal-rooms/call.ts). A bank officer's call
// is a bank call (C-2): refused (409 bank_calls_recorded) while the
// workspace records bank numbers and the bank's DSA terms do not allow
// it; otherwise their number is listed in pbx_bank_numbers just before
// the PBX is asked. The same do-not-contact rule applies, to the number
// across the workspace and to the participant's linked contact.
//
// Unless this build turned calling on (NEXT_PUBLIC_PBX_OUTBOUND_CALLS,
// lib/pbx/outbound.ts) every request is refused (403 outbound_calls_off)
// before the body, the database or the PBX is touched.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { roleRank } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  OVERRIDE_REASON_MAX,
  UUID,
  dncContactIds,
  dncDecision,
  dncRefused,
  fail,
  myExtension,
  noExtension,
  pbxFailure,
  resolveCallee,
  type MyExtension,
} from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import { outboundCallsEnabled } from '@/lib/pbx/outbound';
import {
  listBankNumber,
  participantCallee,
  participantRoomId,
} from '@/lib/deal-rooms/call';

const ID_FIELDS = [
  'contactId',
  'conversationId',
  'dealId',
  'participantId',
] as const;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    if (!outboundCallsEnabled())
      return fail('Calling from the CRM is switched off', 403, {
        code: 'outbound_calls_off',
      });
    const b = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      return fail('Invalid JSON body');
    for (const f of ID_FIELDS)
      if (b[f] !== undefined && !(typeof b[f] === 'string' && UUID.test(b[f])))
        return fail(`${f} must be an id`);
    if (b.number !== undefined && typeof b.number !== 'string')
      return fail('number must be text');
    const override =
      typeof b.overrideReason === 'string' ? b.overrideReason : undefined;
    if (override && override.trim().length > OVERRIDE_REASON_MAX)
      return fail(
        `overrideReason is limited to ${OVERRIDE_REASON_MAX} characters`
      );

    if (
      b.participantId !== undefined &&
      (b.number !== undefined ||
        ID_FIELDS.some((f) => f !== 'participantId' && b[f] !== undefined))
    )
      return fail('participantId is sent alone');

    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();

    const rank = roleRank(ctx.role);
    const service = pbxServiceDb();
    if (typeof b.participantId === 'string') {
      const roomId = await participantRoomId(
        service,
        ctx.accountId,
        b.participantId
      );
      if (!roomId)
        return fail('Participant not found', 404, { code: 'not_found' });
      const { data: canPost, error } = await ctx.supabase.rpc(
        'deal_room_can_post',
        { p_room: roomId }
      );
      if (error) throw new Error(`deal_room_can_post failed: ${error.message}`);
      if (canPost !== true)
        return fail('You cannot call from this deal room', 403, {
          code: 'forbidden',
        });
      const person = await participantCallee(
        service,
        ctx.accountId,
        b.participantId,
        roomId
      );
      if (!person.ok)
        return fail(person.error, person.status, { code: person.code });
      const dnc = await dncContactIds(
        service,
        ctx.accountId,
        person.number,
        person.contactId ? [person.contactId] : []
      );
      return await placeCall({
        ctx,
        service,
        ext,
        rank,
        override,
        number: person.number,
        dnc: dnc.length ? { contactIds: dnc, reason: null } : null,
        auditDetail: {
          participant_id: b.participantId,
          room_id: person.roomId,
        },
        bankCode: person.bankCode,
      });
    }

    let contactId = b.contactId as string | undefined;
    if (!contactId && b.number === undefined) {
      const [table, id] = b.conversationId
        ? ['conversations', b.conversationId as string]
        : b.dealId
          ? ['deals', b.dealId as string]
          : [null, null];
      if (!table) return fail('Choose a contact or enter a number');
      const { data, error } = await ctx.supabase
        .from(table)
        .select('contact_id')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`${table} read failed: ${error.message}`);
      if (!data) return fail('Not found', 404);
      contactId = (data as { contact_id: string | null }).contact_id ?? '';
      if (!contactId) return fail('There is no customer to call here', 422);
    }

    const callee = await resolveCallee({
      rls: ctx.supabase,
      service,
      accountId: ctx.accountId,
      contactId,
      number: contactId ? undefined : (b.number as string),
    });
    if (!callee.ok) return callee.response;
    return await placeCall({
      ctx,
      service,
      ext,
      rank,
      override,
      number: callee.number,
      dnc: callee.dnc,
    });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}

/**
 * Do-not-contact, then the PBX: refused, or an owner's or admin's
 * override written to pbx_audit before the call; a bank officer's
 * number listed as a bank number; then the caller's own extension rings
 * first.
 */
async function placeCall(args: {
  ctx: { accountId: string; userId: string };
  service: SupabaseClient;
  ext: MyExtension;
  rank: number;
  override: string | undefined;
  number: string;
  dnc: { contactIds: string[]; reason: string | null } | null;
  auditDetail?: Record<string, unknown>;
  /** A bank officer's bank: the number is listed under it first. */
  bankCode?: string | null;
}): Promise<NextResponse> {
  const { ctx, service, ext, number, dnc } = args;
  const decision = dncDecision({
    doNotContact: dnc !== null,
    rank: args.rank,
    overrideReason: args.override,
  });
  if (decision.kind === 'refuse') return dncRefused(dnc!.reason);
  if (decision.kind === 'override') {
    const { error } = await service.from('pbx_audit').insert({
      account_id: ctx.accountId,
      actor_id: ctx.userId,
      action: 'dnc_override_call',
      contact_id: dnc!.contactIds[0],
      reason: decision.reason,
      detail: { contact_ids: dnc!.contactIds, number, ...args.auditDetail },
    });
    if (error) throw new Error(`pbx_audit insert failed: ${error.message}`);
  }
  if (args.bankCode)
    await listBankNumber(service, ctx.accountId, number, args.bankCode);

  const { api } = await pbxApiFor(service, ext.connectionId);
  const { callId } = await api.dial({ caller: ext.extension, callee: number });
  return NextResponse.json({ pbxCallId: callId });
}
