// ============================================================
// /api/assist/pending/[id] — the human half of an assistant
// confirmation (module 019a, migration 120).
//
// POST { decision: 'confirm' | 'deny', nonce } from the signed-in
// user: the HumanOrigin is minted here, from the authenticated
// session, and nowhere on the model's tool-call path. The gate's SQL
// re-checks user, account, nonce, status and expiry in one atomic
// update. Nothing calls this yet: 019a stays idle until an assistant
// exists.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/groups/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { ConfirmationGate, humanOriginFromChannel } from '@/lib/assist/confirm';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** assist_pending_request hands out 20 lowercase hex chars (of gen_random_uuid()). */
const NONCE = /^[0-9a-f]{20}$/;

export async function POST(request: Request, { params }: Params) {
  try {
    const { userId, accountId } = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      decision?: unknown;
      nonce?: unknown;
    } | null;
    const decision = body?.decision;
    const nonce = body?.nonce;
    if (!UUID.test(id))
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    if (decision !== 'confirm' && decision !== 'deny')
      return NextResponse.json(
        { error: "decision must be 'confirm' or 'deny'" },
        { status: 400 }
      );
    if (typeof nonce !== 'string' || !NONCE.test(nonce))
      return NextResponse.json({ error: 'Invalid nonce' }, { status: 400 });

    const origin = humanOriginFromChannel({
      userId,
      workspaceId: accountId,
      channel: 'dashboard',
    });
    const gate = new ConfirmationGate(supabaseAdmin());
    const r =
      decision === 'confirm'
        ? await gate.confirm(origin, id, nonce)
        : await gate.deny(origin, id, nonce);
    if (r.ok)
      return NextResponse.json({
        ok: true,
        status: decision === 'confirm' ? 'confirmed' : 'denied',
      });
    return NextResponse.json(
      { error: r.reason },
      { status: r.reason === 'NOT_FOUND' ? 404 : 409 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
