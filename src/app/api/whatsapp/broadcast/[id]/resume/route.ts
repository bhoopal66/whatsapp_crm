// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume   (issue #472)
//
// Delivers the recipients of an existing broadcast that still need
// sending, server-side. Three things use it:
//
//   - "Resume" on a campaign abandoned when its browser tab closed
//     mid-send (the wizard drives the initial fan-out from the tab).
//   - "Retry failed" — the reporter's ask.
//   - Both at once (`scope: 'all'`).
//
// Responds 202 as soon as the pass is claimed and planned; the fan-out
// runs in `after()`. Poll the broadcast row for progress, same as the
// public API's create endpoint.
// ============================================================

import { NextResponse } from 'next/server';
import { after } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import {
  BroadcastError,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import { runBroadcastPass } from '@/lib/whatsapp/broadcast-pass';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_SCOPES,
  type ResumeScope,
} from '@/lib/whatsapp/broadcast-resume';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { failRefusedCampaign } from '@/lib/whatsapp/broadcast-continue';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// The fan-out below is sequential over up to 1 000 recipients.
export const maxDuration = 300;

/**
 * Every row is terminal, or was just stamped so by the planner: settle a
 * campaign that would otherwise read 'sending' for ever. Only that one:
 * a draft with no recipients yet has nothing left to send either.
 */
async function settleIfSending(broadcastId: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('broadcasts')
    .select('status')
    .eq('id', broadcastId)
    .maybeSingle();
  if (data?.status === 'sending') {
    await finalizeBroadcastStatus(admin, broadcastId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let claimedId: string | null = null;
  // The lock's token: the claim, the pass and the release below name it.
  const claimedAt = new Date();
  const token = claimedAt.toISOString();
  let settleId: string | null = null;

  try {
    // Same gate as the batch send endpoint: running a broadcast is a
    // write, and viewers are read-only. Resuming is no different — it
    // puts real messages on real phones.
    const { supabase, accountId, userId } = assertSalesAccess(
      await requireRole('admin')
    );

    const limit = checkRateLimit(
      `broadcast-resume:${userId}`,
      RATE_LIMITS.broadcast
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope)
      ? body.scope
      : 'pending';

    // Claim BEFORE planning. Two clicks on Resume, or a click while an
    // earlier pass is still running, would otherwise both build a plan
    // from the same 'pending' rows and message everyone twice — and a
    // WhatsApp message cannot be recalled. The claim is one conditional
    // UPDATE, so exactly one caller wins.
    const claimed = await claimBroadcastDelivery(
      supabase,
      accountId,
      id,
      claimedAt
    );
    if (!claimed) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
        },
        { status: 409 }
      );
    }
    claimedId = id;
    settleId = id;

    const { plan, remaining, unsendable } = await planBroadcastResume(
      supabase,
      accountId,
      id,
      scope
    );

    await markBroadcastSending(supabase, id);
    claimedId = null; // ownership passes to the after() block

    // Service-role client for the fan-out: it outlives the request, and
    // every id in the plan was already resolved through an
    // account-scoped read above.
    const admin = supabaseAdmin();
    after(() => runBroadcastPass(admin, plan, token));

    return NextResponse.json(
      {
        success: true,
        broadcast_id: id,
        scope,
        resuming: plan.planned.length,
        // > 0 when the backlog exceeded one pass's cap; the UI offers
        // Resume again rather than silently dropping them.
        remaining,
        // Recipients stamped failed up front for want of a phone number.
        unsendable,
      },
      { status: 202 }
    );
  } catch (error) {
    // Planning failed after the claim — release it, or the campaign is
    // locked out of resuming until the staleness window expires.
    if (claimedId) {
      await releaseBroadcastDelivery(supabaseAdmin(), claimedId, token).catch(
        () => {}
      );
    }
    if (error instanceof BroadcastError) {
      if (error.code === 'nothing_to_resume' && settleId) {
        await settleIfSending(settleId).catch(() => {});
      }
      if (error.code === 'template_refused' && settleId) {
        await failRefusedCampaign(
          supabaseAdmin(),
          settleId,
          error.message
        ).catch(() => {});
      }
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error('Error in broadcast resume POST:', error);
    return toErrorResponse(error);
  }
}
