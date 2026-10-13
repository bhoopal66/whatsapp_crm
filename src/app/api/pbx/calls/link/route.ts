// ============================================================
// POST /api/pbx/calls/link — link a call with no customer to the
// contact just created for it, by the call's PBX ids (module 015): the
// incoming-call card's "Create contact" knows the call only as
// call_live's (connection_id, pbx_call_id).
//   { connectionId, pbxCallId, contactId }
//     → { linked: true, callId, contactId, conversationId, dealId }
//     | { linked: false }
//
// The form outlives the card, so the call can end while it is open
// (declined, missed). Its end (30012) matched the number against the
// contacts of that moment, before this one existed, so it is linked
// here. Only a call of the caller's workspace that their own reads see
// (pbx_can_view_call: a party to it, a team leader and up) and that
// still has no contact. Anything else is { linked: false }, not an
// error: a call still live is matched by its number when it ends, and
// a call matched meanwhile keeps its match. The link is the re-link's
// (linkCallContact: pbx_link_call_contact on the caller's client),
// which also keeps an agent to their own calls. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { UUID, fail, jsonObject, linkCallContact } from '@/lib/pbx/calls';

const PBX_CALL_ID_MAX = 128;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    const connectionId =
      typeof b.connectionId === 'string' ? b.connectionId : '';
    const pbxCallId = typeof b.pbxCallId === 'string' ? b.pbxCallId.trim() : '';
    if (
      !UUID.test(connectionId) ||
      !pbxCallId ||
      pbxCallId.length > PBX_CALL_ID_MAX
    )
      return fail('Call not found', 404);
    if (!(typeof b.contactId === 'string' && UUID.test(b.contactId)))
      return fail('contactId must be an id');

    const found = await ctx.supabase
      .from('calls')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('connection_id', connectionId)
      .eq('pbx_call_id', pbxCallId)
      .is('contact_id', null)
      .maybeSingle();
    if (found.error)
      throw new Error(`calls read failed: ${found.error.message}`);
    const callId = (found.data as { id: string } | null)?.id;
    if (!callId) return NextResponse.json({ linked: false });

    const linked = await linkCallContact(ctx.supabase, callId, b.contactId);
    return linked instanceof NextResponse
      ? linked
      : NextResponse.json({ linked: true, callId, ...linked });
  } catch (err) {
    return toErrorResponse(err);
  }
}
