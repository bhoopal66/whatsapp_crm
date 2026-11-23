// POST /api/privacy/erase — PDPL erasure (migration 222). Body
// `{ contactId, dryRun?: boolean (default true), confirm?: string }`.
// Owners and admins only. A dry run counts and changes nothing;
// executing needs confirm = 'ERASE <contactId>'. A legal hold answers
// `{ blocked: 'legal_hold' }` and changes nothing. After the commit the
// erased rows' stored files are deleted here; any left are recorded for
// a retry. `retained` lists what is kept and why (the data map).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { PERSONAL } from '@/lib/privacy/data-map';
import { deleteErasedObjects } from '@/lib/privacy/erase-objects';
import {
  noStore,
  PrivacyBadRequest,
  privacyErrorResponse,
  readBody,
  requireContactId,
} from '@/lib/privacy/http';
import { PrivacyRefusedError, PrivacyStore } from '@/lib/privacy/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

const RETAINED = Object.entries(PERSONAL)
  .filter(([, e]) => e.erase === 'retain')
  .map(([table, e]) => ({ table, reason: e.reason ?? '' }));

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readBody(request);
    const contactId = requireContactId(body.contactId);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')
      throw new PrivacyBadRequest('dryRun must be true or false');
    if (body.confirm !== undefined && typeof body.confirm !== 'string')
      throw new PrivacyBadRequest('confirm must be text');
    const admin = supabaseAdmin();
    const store = new PrivacyStore(admin);
    const result = await store.erase(ctx.userId, ctx.accountId, contactId, {
      dryRun: body.dryRun !== false,
      confirm: (body.confirm as string | undefined) ?? null,
    });
    if (result === null) throw new PrivacyRefusedError('NOT_FOUND');
    if (result.blocked)
      return noStore(NextResponse.json({ ...result, retained: RETAINED }));

    let files = { deleted: 0, remaining: 0, skipped: 0 };
    if (result.mode === 'erase' && result.objects.length > 0) {
      const out = await deleteErasedObjects(
        admin.storage,
        ctx.accountId,
        result.objects
      );
      files = {
        deleted: out.deleted,
        remaining: out.remaining.length,
        skipped: out.skipped,
      };
      await store
        .objectsDone(ctx.userId, ctx.accountId, result.requestId, out.remaining)
        .catch(() =>
          console.error('[privacy] erase: objects_done not recorded')
        );
    }
    return noStore(
      NextResponse.json({
        mode: result.mode,
        requestId: result.requestId,
        counts: result.counts,
        files: { ...files, total: result.objectsCount },
        retained: RETAINED,
      })
    );
  } catch (err) {
    return privacyErrorResponse(err, 'erase');
  }
}
