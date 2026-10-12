import { NextResponse } from 'next/server';

import { UnauthorizedError, toErrorResponse } from '@/lib/auth/account';
import { loadRoomDetail } from '@/lib/deal-rooms/reads';
import { createClient } from '@/lib/supabase/server';

/**
 * One deal room as the caller may see it (module 014c): the room,
 * `access` (`supervisor` | `staff` | `guest`), `canManage`,
 * `windowOpen`, and `participants`: staff get role, status, the consent
 * flag and the phone masked (`+971 XXXXXXX12`); a bank guest gets only
 * the roster (name, role, status). Managers also get `joinRequests`
 * (WhatsApp id masked) and `pendingApprovals`. Guest-capable: the
 * session is checked here and every read runs as the caller, so RLS
 * decides. 404 when the caller cannot see the room.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new UnauthorizedError();
    const { id } = await params;
    const detail = await loadRoomDetail(supabase, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'Deal room not found', code: 'not_found' },
        { status: 404 }
      );
    }
    return NextResponse.json(detail, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
