// POST /api/desk/tray/[id]/suggest — a suggested case for a tray
// document (migration 235, design 035 D12): `{ suggestion }`, one of
// suggested (caseId, p) | off | failed | unsure | tie. Advice only:
// nothing is filed, linked, sent or changed; the Tray tab never
// pre-selects it. Only someone who may sort the item asks.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import {
  DeskRefusedError,
  DeskStoreError,
  DESK_REFUSALS,
  type DeskRefusal,
} from '@/lib/desk/store';
import { suggestTrayCase } from '@/lib/desk/suggest';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const trayId = requireUuid((await params).id, 'id');
    let out;
    try {
      out = await suggestTrayCase(
        supabaseAdmin(),
        ctx.userId,
        ctx.accountId,
        trayId
      );
    } catch (err) {
      const e = err as { hint?: unknown; code?: string };
      if (
        typeof e.hint === 'string' &&
        (DESK_REFUSALS as readonly string[]).includes(e.hint)
      )
        throw new DeskRefusedError(e.hint as DeskRefusal);
      throw new DeskStoreError('desk_tray_suggest_input', e.code ?? null);
    }
    return NextResponse.json({ suggestion: out.suggestion });
  } catch (err) {
    return deskErrorResponse(err, 'tray suggest');
  }
}
