// ============================================================
// POST /api/whatsapp/groups/delete — remove groups our number has LEFT
// from the CRM (owner/admin). Body `{ ids: string[] }`, 1..100 UUIDs.
// Nothing happens on WhatsApp: we are no longer in these groups. The
// child tables (participants, managers, invites, messages) cascade.
//
// Only `our_role = 'left'` rows of the caller's active account are
// deleted, and both filters sit on the DELETE itself, not just on the
// read before it: a group re-joined (synced back to member/admin) in
// between must survive. `DELETE /api/whatsapp/groups/[id]` is LEAVE,
// not this.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid, supabaseAdmin } from '@/lib/groups/server';

export const MAX_DELETE_IDS = 100;

function parseIds(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const ids = (raw as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (ids.length > MAX_DELETE_IDS || !ids.every(isUuid)) return null;
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const ids = parseIds(await request.json().catch(() => null));
    if (!ids) {
      return NextResponse.json(
        { error: `ids must be 1 to ${MAX_DELETE_IDS} group ids` },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const found = await admin
      .from('whatsapp_groups')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('our_role', 'left')
      .in('id', ids);
    if (found.error) throw found.error;
    const leftIds = ((found.data ?? []) as Array<{ id: string }>).map(
      (g) => g.id
    );

    let deleted: string[] = [];
    if (leftIds.length > 0) {
      const del = await admin
        .from('whatsapp_groups')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('our_role', 'left')
        .in('id', leftIds)
        .select('id');
      if (del.error) throw del.error;
      deleted = ((del.data ?? []) as Array<{ id: string }>).map((g) => g.id);
    }

    const gone = new Set(deleted);
    return NextResponse.json({
      deleted,
      skipped: ids.filter((id) => !gone.has(id)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
