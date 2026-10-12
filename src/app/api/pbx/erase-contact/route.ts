// ============================================================
// POST /api/pbx/erase-contact — Settings → Consent and retention's
// lawful erasure of a customer's call recordings (C-3). Owner only.
// Body `{ contactId, reason }`.
//
// pbx_erase_contact_calls runs on the caller's own session, so the RPC
// checks the owner role and writes pbx_audit under their name. It
// deletes the recording rows, blanks the calls' notes and outcomes, and
// returns the storage paths; those objects are removed here with the
// service role, because call-recordings has no client DELETE. Only
// paths under the caller's `account-<id>/` prefix are touched. The rows
// are already gone by then, so a path that cannot be removed is logged
// and counted, never thrown: the erasure itself has committed, and the
// PBX cron sweeps the leftover audio (sweepOrphanRecordings).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { chatFilesOfAccount, chunked, reasonOk } from '@/lib/chat/admin-tools';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { RECORDINGS_BUCKET, UUID, dbFailure } from '@/lib/pbx/calls';

/** Storage removes take a bounded list. */
const FILE_BATCH = 100;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const contactId =
      typeof body?.contactId === 'string' ? body.contactId.trim() : '';
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!UUID.test(contactId)) {
      return NextResponse.json(
        { error: 'Choose the customer whose recordings to erase' },
        { status: 400 }
      );
    }
    if (!reasonOk(reason)) {
      return NextResponse.json(
        { error: 'A reason of at least 5 characters is required' },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.supabase.rpc('pbx_erase_contact_calls', {
      p_contact_id: contactId,
      p_reason: reason,
    });
    if (error) {
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_erase_contact_calls failed: ${error.message}`);
    }

    const paths = Array.isArray(data)
      ? data.filter((p): p is string => typeof p === 'string')
      : [];
    // Recordings use the chat files' scheme, `account-<id>/…`
    // (lib/pbx/recordings.ts), so the same prefix check applies.
    const owned = chatFilesOfAccount(paths, ctx.accountId);
    const failed = paths.filter((p) => !owned.includes(p));
    let deleted = 0;
    const storage = pbxServiceDb().storage.from(RECORDINGS_BUCKET);
    for (const batch of chunked(owned, FILE_BATCH)) {
      // One retry: a storage blip should not leave recordings behind.
      let result = await storage.remove(batch);
      if (result.error) result = await storage.remove(batch);
      if (result.error) failed.push(...batch);
      else deleted += result.data?.length ?? 0;
    }
    if (failed.length > 0) {
      console.error(
        `[POST /api/pbx/erase-contact] ${failed.length} erased recording(s) left in ${RECORDINGS_BUCKET} for account ${ctx.accountId}:`,
        failed
      );
    }

    return NextResponse.json({
      recordings: paths.length,
      deleted,
      failed: failed.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
