// ============================================================
// POST /api/pbx/calls/{callId}/link — re-link a mis-matched call to a
// customer (module 015, migration 089). `[id]` here is the CRM call id
// (calls.id).
//   { contactId } → { contactId, conversationId, dealId }
//
// pbx_link_call_contact, on the caller's client, decides everything: a
// call and a contact the caller can see in the same workspace (404
// otherwise), not an internal call (400), not an erased one (409). The
// call's chat follows the contact; a deal of another contact is dropped.
// Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { UUID, fail, jsonObject, linkCallContact } from '@/lib/pbx/calls';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!UUID.test(id)) return fail('Call not found', 404);
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    if (!(typeof b.contactId === 'string' && UUID.test(b.contactId)))
      return fail('contactId must be an id');

    const linked = await linkCallContact(ctx.supabase, id, b.contactId);
    return linked instanceof NextResponse ? linked : NextResponse.json(linked);
  } catch (err) {
    return toErrorResponse(err);
  }
}
