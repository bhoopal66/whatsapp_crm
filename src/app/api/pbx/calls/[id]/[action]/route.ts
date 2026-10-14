// ============================================================
// POST /api/pbx/calls/{pbxCallId}/{action} — live call control (module
// 015, migration 089). `[id]` here is the PBX's call id (the dial
// route's pbxCallId, call_live.pbx_call_id), not a CRM calls.id.
//   action: hangup | hold | unhold | mute | unmute → { ok: true }
//   action: transfer, { number } | { toOwner: true } → { ok, number }
//
// A person controls only their OWN leg, from their OWN extension: the
// PBX is asked which calls the caller's mapped extension
// (pbx_my_extension(), on their client) is on, and the call must list
// that extension as a member still on it (myLiveLeg); otherwise 404,
// whatever the caller's role or what call_live shows them. The action
// is sent for the caller's channel. A blind transfer moves the party at
// the other end (blindTransferChannel): to `number`, any extension, or
// an outside number held to the old rule (below team leader, only a
// number of a contact the caller can see; never a do-not-contact
// customer's), or with `toOwner` to the extension of the call's
// customer's owner on the same PBX. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { roleRank } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  blindTransferChannel,
  dncRefused,
  fail,
  isCallAction,
  jsonObject,
  myExtension,
  myLiveLeg,
  noExtension,
  pbxFailure,
  resolveCallee,
} from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';

const PBX_CALL_ID_MAX = 128;

type Target =
  { ok: true; number: string } | { ok: false; response: NextResponse };

/** The call's customer (a re-link lands on calls; else the screen pop). */
async function ownerExtension(
  service: SupabaseClient,
  accountId: string,
  connectionId: string,
  pbxCallId: string
): Promise<Target> {
  const refuse = (error: string, code: string): Target => ({
    ok: false,
    response: fail(error, 409, { code }),
  });
  let contactId: string | null = null;
  for (const table of ['calls', 'call_live'] as const) {
    const { data, error } = await service
      .from(table)
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('connection_id', connectionId)
      .eq('pbx_call_id', pbxCallId)
      .maybeSingle();
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    contactId =
      (data as { contact_id: string | null } | null)?.contact_id ?? null;
    if (contactId) break;
  }
  if (!contactId)
    return refuse(
      'This call has no customer to find an owner for',
      'no_contact'
    );
  const contact = await service
    .from('contacts')
    .select('user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (contact.error)
    throw new Error(`contacts read failed: ${contact.error.message}`);
  const ownerId = (contact.data as { user_id: string | null } | null)?.user_id;
  if (!ownerId) return refuse('This customer has no owner', 'no_owner');
  const ext = await service
    .from('pbx_extensions')
    .select('extension')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (ext.error)
    throw new Error(`pbx_extensions read failed: ${ext.error.message}`);
  const number = (ext.data as { extension: string } | null)?.extension;
  if (!number)
    return refuse(
      'The customer’s owner has no phone extension on this phone system',
      'owner_no_extension'
    );
  return { ok: true, number };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id, action } = await context.params;
    if (!isCallAction(action)) return fail('Unknown call action', 404);
    const pbxCallId = id.trim();
    if (!pbxCallId || pbxCallId.length > PBX_CALL_ID_MAX)
      return fail('Call not found', 404);

    let toOwner = false;
    let typed: string | undefined;
    if (action === 'transfer') {
      const b = await jsonObject(request);
      if (!b) return fail('Invalid JSON body');
      toOwner = b.toOwner === true;
      if (b.toOwner !== undefined && typeof b.toOwner !== 'boolean')
        return fail('toOwner must be true or false');
      if (b.number !== undefined && typeof b.number !== 'string')
        return fail('number must be text');
      typed = b.number as string | undefined;
      if (toOwner === (typed !== undefined))
        return fail('Send either a number or toOwner: true');
    }

    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();
    const service = pbxServiceDb();
    const { api } = await pbxApiFor(service, ext.connectionId);
    const leg = myLiveLeg(
      await api.queryCalls({ extension: ext.extension }),
      pbxCallId,
      ext.extension
    );
    if (!leg)
      return fail('You are not on this call', 404, { code: 'not_on_call' });

    if (action !== 'transfer') {
      await api[action]({ channelId: leg.mine.channelId });
      return NextResponse.json({ ok: true });
    }

    const channelId = blindTransferChannel(leg.others);
    if (!channelId)
      return fail(
        'There is no single other party on this call to transfer',
        409,
        {
          code: 'no_transfer_party',
        }
      );
    let target: Target;
    if (toOwner) {
      target = await ownerExtension(
        service,
        ctx.accountId,
        ext.connectionId,
        pbxCallId
      );
    } else {
      const callee = await resolveCallee({
        rls: ctx.supabase,
        service,
        accountId: ctx.accountId,
        number: typed,
        transferRank: roleRank(ctx.role),
      });
      if (!callee.ok) return callee.response;
      if (callee.dnc) return dncRefused(callee.dnc.reason);
      target = { ok: true, number: callee.number };
    }
    if (!target.ok) return target.response;
    if (target.number === ext.extension)
      return fail('You are already on this call', 409);

    await api.transfer({ type: 'blind', channelId, number: target.number });
    return NextResponse.json({ ok: true, number: target.number });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
