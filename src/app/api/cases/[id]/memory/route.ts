// ============================================================
// /api/cases/[id]/memory — the case's CRM memory (019b).
//
// GET `?before=&limit=`: the scope's live items, newest first,
// keyset-paged by `before` (ISO time; memory_list, limit 1–200, default
// 50). The memory_* functions decide who reads. Answers `{ items }`.
// Search is POST …/memory/search, so the text stays out of the URL and
// out of access logs: a GET that still sends `q` is 400.
//
// POST `{ content, kind?, importance?, supersedes? }`: a case writer who
// is not a workspace viewer adds a verified staff memory (tokenised into
// the vault when it is configured, else redacted). Refusals are 422 with
// the refusal code (REDACTION_REFUSED when redaction refused the text).
// Answers 201 `{ itemId, deduped }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canWriteCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  loadCaseForCaller,
  readJsonObject,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { memoryStore, staffMemoryDeps } from '@/lib/memory/server';
import { addStaffMemory } from '@/lib/memory/staff';
import type { MemoryKind, MemoryScope } from '@/lib/memory/store';

type Params = { params: Promise<{ id: string }> };

const LIST_MAX = 200;
const KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'decision',
  'document',
  'summary',
];

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const scope: MemoryScope = { type: 'case', id: c.id };

    const sp = new URL(request.url).searchParams;
    if (sp.has('q')) throw badRequest('Search with POST');
    const rawLimit = sp.get('limit');
    let limit: number | undefined;
    if (rawLimit !== null && rawLimit !== '') {
      limit = /^\d{1,9}$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!(limit >= 1 && limit <= LIST_MAX))
        throw badRequest(`limit must be a whole number 1–${LIST_MAX}`);
    }

    const store = memoryStore();
    const rawBefore = sp.get('before');
    let before: Date | null = null;
    if (rawBefore !== null && rawBefore !== '') {
      before = new Date(rawBefore);
      if (Number.isNaN(before.getTime()))
        throw badRequest('before must be an ISO time');
    }
    const items = await store.list(ctx.userId, ctx.accountId, scope, {
      limit,
      before,
    });
    return NextResponse.json({ items });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c, role } = await loadCaseForCaller(ctx, id, caseStore());
    if (!canWriteCase(role) || ctx.role === 'viewer')
      throw new CaseHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    if (!body || typeof body.content !== 'string')
      throw badRequest('content is required');
    let kind: MemoryKind | undefined;
    if (body.kind !== undefined && body.kind !== null) {
      if (!KINDS.includes(body.kind as MemoryKind))
        throw badRequest('kind is not valid');
      kind = body.kind as MemoryKind;
    }
    let importance: number | undefined;
    if (body.importance !== undefined && body.importance !== null) {
      const n = body.importance;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5)
        throw badRequest('importance must be a whole number 1–5');
      importance = n;
    }
    let supersedes: string | null = null;
    if (body.supersedes !== undefined && body.supersedes !== null) {
      if (!isUuid(body.supersedes)) throw badRequest('supersedes is not valid');
      supersedes = body.supersedes;
    }

    const result = await addStaffMemory(staffMemoryDeps(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      scope: { type: 'case', id: c.id },
      content: body.content,
      kind,
      importance,
      supersedes,
    });
    if (!result.ok) {
      const code =
        result.refused === true ? 'REDACTION_REFUSED' : result.refused;
      return NextResponse.json(
        { error: 'Memory refused', code },
        { status: 422 }
      );
    }
    return NextResponse.json(
      { itemId: result.id, deduped: result.deduped },
      { status: 201 }
    );
  } catch (err) {
    return caseErrorResponse(err);
  }
}
