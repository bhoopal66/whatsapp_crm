// ============================================================
// /api/cases/status-map/apply — POST `{ status }`: re-apply a mapped
// Compass status to every open case of the account whose group holds it
// now (case_status_map_apply, migration 151). Owner / admin only;
// answers `{ moved, unchanged }`. Runs on the service role with p_actor =
// the caller's auth user id; the SQL re-checks the actor (NOT_ALLOWED)
// and refuses with a HINT code (422).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { readObject, requiredText } from '@/lib/cases/http';
import {
  applyStatusMapping,
  MAX_STATUS_CHARS,
  statusMapErrorResponse,
} from '@/lib/cases/status-map';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readObject(request);
    const status = requiredText(body.status, 'status', MAX_STATUS_CHARS);
    return NextResponse.json(
      await applyStatusMapping(supabaseAdmin(), ctx.userId, status)
    );
  } catch (err) {
    return statusMapErrorResponse(err, 'apply');
  }
}
