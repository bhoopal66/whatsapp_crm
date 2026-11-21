// POST /api/desk/intake/[id]/retag — the uploader corrects the tags of
// their own waiting upload; it is routed again. Body: the tag fields of
// POST /api/desk/intake (no file, no caption) -> 200 `{ item }`.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  deskErrorResponse,
  parseTags,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const itemId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    const item = await new DeskStore(supabaseAdmin()).retag(
      ctx.userId,
      ctx.accountId,
      itemId,
      parseTags((n) => body[n])
    );
    return NextResponse.json({ item });
  } catch (err) {
    return deskErrorResponse(err, 'intake retag');
  }
}
