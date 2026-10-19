// ============================================================
// POST /api/contacts/[id]/memory/search — search the customer's CRM
// memory (019b). The text travels in the body, not the URL, so an ID
// number typed into search stays out of proxy and access logs.
//
// `{ q (1–500 characters), limit? (1–100, default 20) }`, with the
// contact loaded with the caller's RLS client first (one they cannot see
// is 404). A search of this contact's scope only (memory_recall_
// candidates; the memory_* functions decide who reads). Answers
// `{ items }` (without their embedding), never cached.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  loadContactScope,
  memoryBadRequest,
  memoryErrorResponse,
  readJsonObject,
} from '@/lib/memory/contact-http';
import { parseMemorySearch } from '@/lib/memory/search-request';
import { memoryStore } from '@/lib/memory/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const scope = await loadContactScope(ctx, id);

    const search = parseMemorySearch(await readJsonObject(request));
    if (!search.ok) throw memoryBadRequest(search.error);

    const items = await memoryStore().recall(
      ctx.userId,
      ctx.accountId,
      search.q,
      search.limit,
      [scope]
    );
    return NextResponse.json(
      // undefined drops the key: the vector is no use to the screen.
      { items: items.map((item) => ({ ...item, embedding: undefined })) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return memoryErrorResponse(err);
  }
}
