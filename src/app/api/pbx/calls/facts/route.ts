// ============================================================
// GET /api/pbx/calls/facts?connectionId&pbxCallId[&contactId] — what
// the call screens show of a LIVE call's customer (module 015).
//   → CallFacts (src/lib/pbx/call-facts.ts)
//
// Only for a ringing or answering party of the live call (call_live, in
// the caller's own account; 404 otherwise, whatever their role), and
// only for the call's own contact or one of its number's candidates.
// When the caller's own reads see the contact (RLS: can_view_contact),
// the facts are read through those reads, as the card read them before.
// When they do not — another RM's customer ringing this person — the
// service role reads, inside the call's account, only what taking the
// call needs: the name, the owner and the consent flags (`hidden`), so
// a do-not-contact customer never shows as "Calls OK". Not the
// free-text reason, and only for the call's own match (call_live
// .contact_id): a candidate the caller cannot see is a 404, so the
// route never lists the number's other customers. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  HIDDEN_CONSENT_COLUMNS,
  hiddenFacts,
  loadVisibleFacts,
} from '@/lib/pbx/call-facts';
import {
  callContactIds,
  isLiveParty,
  type CallLiveRow,
} from '@/lib/pbx/call-ui';
import { UUID, fail } from '@/lib/pbx/calls';

const PBX_CALL_ID_MAX = 128;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const q = new URL(request.url).searchParams;
    const connectionId = q.get('connectionId') ?? '';
    const pbxCallId = (q.get('pbxCallId') ?? '').trim();
    const asked = q.get('contactId');
    if (
      !UUID.test(connectionId) ||
      !pbxCallId ||
      pbxCallId.length > PBX_CALL_ID_MAX
    )
      return fail('Call not found', 404);
    if (asked !== null && !UUID.test(asked))
      return fail('contactId must be an id');

    const service = pbxServiceDb();
    const live = await service
      .from('call_live')
      .select('contact_id, ringing_user_ids, answered_by, members')
      .eq('account_id', ctx.accountId)
      .eq('connection_id', connectionId)
      .eq('pbx_call_id', pbxCallId)
      .maybeSingle();
    if (live.error)
      throw new Error(`call_live read failed: ${live.error.message}`);
    const row = live.data as CallLiveRow | null;
    if (!row || !isLiveParty(row, ctx.userId))
      return fail('You are not on this call', 404, { code: 'not_on_call' });
    const contactId = asked ?? row.contact_id;
    if (!contactId || !callContactIds(row).includes(contactId))
      return fail('Customer not found', 404);

    const visible = await loadVisibleFacts(ctx.supabase, contactId);
    if (visible) return NextResponse.json(visible);
    if (contactId !== row.contact_id) return fail('Customer not found', 404);

    const c = await service
      .from('contacts')
      .select(`name, user_id, ${HIDDEN_CONSENT_COLUMNS}`)
      .eq('account_id', ctx.accountId)
      .eq('id', contactId)
      .maybeSingle();
    if (c.error) throw new Error(`contacts read failed: ${c.error.message}`);
    const contact = c.data as Record<string, unknown> | null;
    if (!contact) return fail('Customer not found', 404);
    let ownerName: string | null = null;
    if (typeof contact.user_id === 'string') {
      const p = await service
        .from('profiles')
        .select('full_name')
        .eq('account_id', ctx.accountId)
        .eq('user_id', contact.user_id)
        .maybeSingle();
      if (p.error) throw new Error(`profiles read failed: ${p.error.message}`);
      ownerName =
        (p.data as { full_name: string | null } | null)?.full_name ?? null;
    }
    return NextResponse.json(hiddenFacts(contact, ownerName));
  } catch (err) {
    return toErrorResponse(err);
  }
}
