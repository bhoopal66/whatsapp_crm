// ============================================================
// /api/banks/[id]/posts/[postId]/retract — retract a post (018c, 126).
// Posts are never edited; Postgres lets only the author retract one
// (NOT_ALLOWED, 403) and listings then hide its body. The post must be in
// one of the workspace's threads (else 404).
// POST -> `{ ok: true }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankPost } from '@/lib/cases/bank-http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string; postId: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, postId } = await params;
    const store = bankWorkspaceStore();
    const { post } = await loadBankPost(store, ctx, id, postId);
    await store.retractPost(post.postId, ctx.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
