// GET /api/desk/digest — the reminder digest settings (migration 234):
// `{ settings }`. Staff.
// PUT — `{ enabled, templateName, language, sendHour, gapDays,
// expectedUpdatedAt }`, owners and admins; answers `{ ok, updatedAt }`.
// `expectedUpdatedAt` is the `updatedAt` the card loaded (null: nothing
// stored); another stored version, or no key, is 409 SETTINGS_CHANGED
// (316). Switching on needs an approved utility template whose body
// has {{1}} (application number) and {{2}} (what is missing)
// (TEMPLATE_INVALID); switching off cancels the queued digests.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  DeskBadRequest,
  deskErrorResponse,
  expectedVersion,
  optionalText,
  readJson,
} from '@/lib/desk/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';
import { DeskStore } from '@/lib/desk/store';

const int = (v: unknown, lo: number, hi: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw new DeskBadRequest(`${name} must be ${lo} to ${hi}`);
  return v;
};

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const settings = await new DeskStore(supabaseAdmin()).digestSettings(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ settings });
  } catch (err) {
    return deskErrorResponse(err, 'digest settings');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    if (typeof body.enabled !== 'boolean')
      throw new DeskBadRequest('enabled must be true or false');
    const language = optionalText(body.language, 5, 'language') ?? 'en';
    const updatedAt = await new DeskStore(supabaseAdmin()).setDigestSettings(
      ctx.userId,
      ctx.accountId,
      {
        enabled: body.enabled,
        templateName: optionalText(body.templateName, 200, 'templateName'),
        language,
        sendHour: int(body.sendHour, 8, 20, 'sendHour'),
        gapDays: int(body.gapDays, 1, 14, 'gapDays'),
        expectedUpdatedAt: expectedVersion(body),
      }
    );
    return NextResponse.json({ ok: true, updatedAt });
  } catch (err) {
    return deskErrorResponse(err, 'digest settings save');
  }
}
