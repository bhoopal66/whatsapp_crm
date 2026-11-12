// ============================================================
// /api/cases/[id]/notes — internal case notes (018c, migration 123).
// INTERNAL ONLY: a note never reaches the customer. GET (any case role):
// `{ notes }`, each `{ id, caseId, authorId, systemAuthor, body, mentions, createdAt }`;
// a system note (migration 179) has authorId null and systemAuthor
// 'system:files' | 'system:rules'.
// POST (case writers) `{ body }` (trimmed, 1–10000 characters) -> 201
// `{ noteId, mentioned, ignored }`: `@<uuid>` mentions of people who may
// act on the case are stored, every other handle is returned in ignored.
// Note text is never logged.
// ============================================================

import { after, NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  caseErrorResponse,
  loadCaseForCaller,
  readObject,
  requiredText,
} from '@/lib/cases/http';
import { caseNotesStore, caseStore } from '@/lib/cases/server';
import { brainSink } from '@/lib/brain/sink';

type Params = { params: Promise<{ id: string }> };

const NOTE_MAX = 10000;

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: false,
      }
    );
    return NextResponse.json({ notes: await caseNotesStore().list(c.id) });
  } catch (err) {
    return caseErrorResponse(err, 'notes GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: true,
      }
    );
    const body = requiredText(
      (await readObject(request)).body,
      'body',
      NOTE_MAX
    );
    const added = await caseNotesStore().add(c.id, ctx.userId, body);
    after(() =>
      brainSink().record({
        kind: 'note',
        ref: {
          accountId: ctx.accountId,
          caseId: c.id,
          contactId: c.contactId ?? null,
          bankCode: c.bankCode ?? null,
          createdBy: ctx.userId,
        },
        noteId: added.noteId,
        body,
      })
    );
    return NextResponse.json(added, { status: 201 });
  } catch (err) {
    return caseErrorResponse(err, 'notes POST');
  }
}
