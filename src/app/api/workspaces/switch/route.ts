// ============================================================
// POST /api/workspaces/switch — { accountId } → 200 { accountId }
//
// Makes another of the caller's workspaces the active one
// (`switch_account`, migration 083); RLS and `current_account_id()`
// follow it from the next request. 403 when the caller has no
// non-deactivated membership there.
//
// Authenticated by the session alone, not `getCurrentAccount`: that
// refuses a caller whose active workspace deactivated them, and moving
// to another workspace is exactly what such a person needs to do.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/server';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
    } | null;
    const accountId = body?.accountId;
    if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "'accountId' must be a workspace id" },
        { status: 400 }
      );
    }

    const { error } = await supabase.rpc('switch_account', {
      p_account_id: accountId,
    });
    if (error) {
      if (error.code === '42501') {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      console.error(
        '[POST /api/workspaces/switch] switch_account failed:',
        error
      );
      return NextResponse.json(
        { error: 'Could not switch workspace' },
        { status: 500 }
      );
    }

    return NextResponse.json({ accountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
