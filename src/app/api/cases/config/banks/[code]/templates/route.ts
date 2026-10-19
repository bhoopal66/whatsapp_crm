// ============================================================
// /api/cases/config/banks/[code]/templates — one bank's task templates
// (module 018c, migration 123). GET (agent and up): `{ templates }`, each
// `{ accountId, bankCode, templateKey, title, position, dueHours }`.
// POST (owner / admin) `{ template_key, title, position?, due_hours? }`
// -> `{ template }` (create or update). DELETE `?key=` -> `{ deleted }`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  bankCodeParam,
  configErrorResponse,
  optionalPositiveInt,
  queryParam,
  requireBank,
} from '@/lib/cases/config-http';
import { readObject, requiredKey, requiredText } from '@/lib/cases/http';
import { caseToolsStore } from '@/lib/cases/server';
import { BANK_SPACE_TEMPLATE_KEY } from '@/lib/cases/settings-ui';

type Params = { params: Promise<{ code: string }> };

const TITLE_MAX = 200;

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const code = bankCodeParam((await params).code);
    await requireBank(ctx.supabase, ctx.accountId, code);
    const { templates } = await caseToolsStore().bankConfig(
      ctx.accountId,
      code
    );
    return NextResponse.json({ templates });
  } catch (err) {
    return configErrorResponse(err, 'config templates GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const body = await readObject(request);
    const template = await caseToolsStore().upsertTaskTemplate(ctx.userId, {
      accountId: ctx.accountId,
      bankCode: code,
      templateKey: requiredKey(body.template_key, 'template_key'),
      title: requiredText(body.title, 'title', TITLE_MAX),
      position: optionalPositiveInt(body.position, 'position'),
      dueHours: optionalPositiveInt(body.due_hours, 'due_hours'),
    });
    return NextResponse.json({ template });
  } catch (err) {
    return configErrorResponse(err, 'config templates POST');
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const key = requiredKey(queryParam(request, 'key'), 'key');
    // Bank spaces' "Action needed" creates its task from this template;
    // without it every mark answers TEMPLATE_NOT_FOUND.
    if (key === BANK_SPACE_TEMPLATE_KEY) {
      return NextResponse.json(
        { error: 'This template is used by bank spaces and cannot be deleted' },
        { status: 400 }
      );
    }
    const deleted = await caseToolsStore().deleteTaskTemplate(
      ctx.userId,
      ctx.accountId,
      code,
      key
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return configErrorResponse(err, 'config templates DELETE');
  }
}
