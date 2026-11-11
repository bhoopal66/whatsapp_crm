// ============================================================
// /api/cases/status-map — Settings -> Cases: which case stage each
// Compass status name means (migration 151). Owner / admin only.
//
// GET: `{ stages, mapped, unmapped, suggestions, available }` —
// case_status_map_overview, plus Jev's suggestion per unmapped status
// (keyed by status_key; `{ stage | null, p, runnerUp }`, null = the status
// names no stage) and whether Jev is usable for this account at all.
// `?suggestions=0` skips Jev (`suggestions: {}`, the real `available`):
// the Settings card paints the table from it, then asks again for the
// suggestions, which can take 5-15 s on a cold cache.
// PUT `{ status, stage, source: 'admin' | 'suggestion', suggestedP? }`:
// `{ mapping }` (case_status_map_set). DELETE `?status=`: `{ deleted }`.
//
// The RPCs run on the service role with p_actor = the caller's auth user
// id and re-check the actor (NOT_ALLOWED); the account is the actor's
// active one, never a body value. Refusals answer 422 with their code.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { queryParam } from '@/lib/cases/config-http';
import { badRequest, oneOf, readObject, requiredText } from '@/lib/cases/http';
import {
  deleteStatusMapping,
  loadStatusMapOverview,
  MAX_STAGE_CHARS,
  MAX_STATUS_CHARS,
  setStatusMapping,
  STATUS_MAP_SOURCES,
  statusMapErrorResponse,
  suggestionsAvailable,
  suggestStages,
} from '@/lib/cases/status-map';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const overview = await loadStatusMapOverview(supabaseAdmin(), ctx.userId);
    const suggestions =
      queryParam(request, 'suggestions') === '0'
        ? {}
        : await suggestStages(ctx.accountId, overview);
    return NextResponse.json({
      ...overview,
      suggestions,
      available: suggestionsAvailable(ctx.accountId),
    });
  } catch (err) {
    return statusMapErrorResponse(err, 'GET');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const body = await readObject(request);
    const status = requiredText(body.status, 'status', MAX_STATUS_CHARS);
    const stage = requiredText(body.stage, 'stage', MAX_STAGE_CHARS);
    const source = oneOf(body.source, STATUS_MAP_SOURCES, 'source');
    const p = body.suggestedP;
    if (
      p !== undefined &&
      p !== null &&
      (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
    )
      throw badRequest('suggestedP must be a number from 0 to 1');
    const mapping = await setStatusMapping(supabaseAdmin(), ctx.userId, {
      status,
      stage,
      source,
      suggestedP: typeof p === 'number' ? p : null,
    });
    return NextResponse.json({ mapping });
  } catch (err) {
    return statusMapErrorResponse(err, 'PUT');
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const status = requiredText(
      queryParam(request, 'status'),
      'status',
      MAX_STATUS_CHARS
    );
    const deleted = await deleteStatusMapping(
      supabaseAdmin(),
      ctx.userId,
      status
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return statusMapErrorResponse(err, 'DELETE');
  }
}
