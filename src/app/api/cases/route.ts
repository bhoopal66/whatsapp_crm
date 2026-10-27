// ============================================================
// /api/cases — the coordinator inbox and opening a case (018c).
//
// GET: one `case_inbox` call on the service role for the caller's ACTIVE
// account; Postgres decides which cases the caller sees. Query params
// map onto the inbox filters (lib/cases/http.ts); a bad value is the
// inbox's own refusal (422 with `code`). Each row also carries the
// tracker's own `submissionStatus` (lib/cases/submission-status.ts) and
// the linked contact's own name, `contactOwnName` (lib/cases/contact-names.ts).
//
// POST: owner / admin only. Opens the case of a submission group of the
// caller's account (idempotent per group): 201 when created, 200 when it
// already existed.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  parseAmount,
  parseInboxQuery,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { contactNames } from '@/lib/cases/contact-names';
import { CaseInbox } from '@/lib/cases/inbox';
import { caseStore } from '@/lib/cases/server';
import { submissionStatuses } from '@/lib/cases/submission-status';
import {
  submissionGroupStore,
  supabaseAdmin,
} from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { filters, limit, after } = parseInboxQuery(
      new URL(request.url).searchParams
    );
    const db = supabaseAdmin();
    const page = await new CaseInbox(db).list(
      ctx.userId,
      ctx.accountId,
      filters,
      { limit, after }
    );
    const [statuses, names] = await Promise.all([
      submissionStatuses(
        db,
        ctx.accountId,
        page.rows.map((r) => r.caseId)
      ),
      contactNames(
        db,
        ctx.accountId,
        page.rows.map((r) => r.contactId)
      ),
    ]);
    return NextResponse.json({
      ...page,
      rows: page.rows.map((r) => ({
        ...r,
        submissionStatus: statuses.get(r.caseId) ?? null,
        contactOwnName: r.contactId ? (names.get(r.contactId) ?? null) : null,
      })),
    });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

/** An optional field: absent / null -> undefined, else parsed or 400. */
function optional<T>(
  v: unknown,
  parse: (v: unknown) => T | null,
  name: string
): T | undefined {
  if (v === undefined || v === null) return undefined;
  const parsed = parse(v);
  if (parsed === null) throw badRequest(`${name} is not valid`);
  return parsed;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readJsonObject(request);
    if (!body || !isUuid(body.group_id))
      throw badRequest('group_id must be a uuid');
    const bankCode = optional(body.bank, (v) => parseText(v), 'bank');
    const product = optional(body.product, (v) => parseText(v), 'product');
    const amount = optional(body.amount, parseAmount, 'amount');

    const group = await submissionGroupStore(supabaseAdmin()).get(
      body.group_id
    );
    if (!group || group.accountId !== ctx.accountId)
      throw new CaseHttpError(404, 'Group not found');

    const result = await caseStore(ctx.accountId).open(
      group.id,
      { bankCode, product, amount },
      ctx.userId
    );
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
