// ============================================================
// POST /api/pbx/calls/dial — click-to-call (module 015, migration 089).
// { contactId? | number?, conversationId?, dealId?, overrideReason? }
//   → { pbxCallId }
//
// The PBX rings the caller's OWN extension (pbx_my_extension(), on the
// caller's client) and then the customer: an extension in the body is
// never read (C-7). The callee is a contact the caller can see, the
// contact of a conversation or deal they can see, or a typed number
// (resolveCallee: a visible contact's, or any for a team leader and up).
// A do-not-contact customer is refused (409, code do_not_contact)
// unless an owner or admin sends overrideReason, which is written to
// pbx_audit before the PBX is asked. No calls row is made here: the
// event processor creates it from the PBX's events. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { roleRank } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  OVERRIDE_REASON_MAX,
  UUID,
  dncDecision,
  dncRefused,
  fail,
  myExtension,
  noExtension,
  pbxFailure,
  resolveCallee,
} from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';

const ID_FIELDS = ['contactId', 'conversationId', 'dealId'] as const;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
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

    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();

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

    const rank = roleRank(ctx.role);
    const service = pbxServiceDb();
    const callee = await resolveCallee({
      rls: ctx.supabase,
      service,
      accountId: ctx.accountId,
      rank,
      contactId,
      number: contactId ? undefined : (b.number as string),
    });
    if (!callee.ok) return callee.response;

    const decision = dncDecision({
      doNotContact: callee.dnc !== null,
      rank,
      overrideReason: override,
    });
    if (decision.kind === 'refuse') return dncRefused(callee.dnc!.reason);
    if (decision.kind === 'override') {
      const { error } = await service.from('pbx_audit').insert({
        account_id: ctx.accountId,
        actor_id: ctx.userId,
        action: 'dnc_override_call',
        contact_id: callee.dnc!.contactIds[0],
        reason: decision.reason,
        detail: { contact_ids: callee.dnc!.contactIds, number: callee.number },
      });
      if (error) throw new Error(`pbx_audit insert failed: ${error.message}`);
    }

    const { api } = await pbxApiFor(service, ext.connectionId);
    const { callId } = await api.dial({
      caller: ext.extension,
      callee: callee.number,
    });
    return NextResponse.json({ pbxCallId: callId });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
