// ============================================================
// /api/cases/views — saved Cases inbox views (migration 185).
//
// GET: `{ views }`, the caller's own views plus the shared views of their
// ACTIVE workspace (185 reads the active profile itself).
//
// POST: `{ viewId?, name, filters, sort?, shared? }` creates (no viewId)
// or replaces the caller's own view -> `{ view }`. `filters` uses the
// inbox's camelCase keys (no `sort`: that is the view's own field).
// 422 NAME_INVALID / FILTER_INVALID; 403 NOT_ALLOWED (a viewer, or
// sharing below admin, or another person's shared view); 404
// VIEW_NOT_FOUND (unknown, another person's private view, another
// workspace's view).
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  readObject,
} from '@/lib/cases/http';
import { caseViews } from '@/lib/cases/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const views = await caseViews().list(ctx.userId);
    return NextResponse.json({ views });
  } catch (err) {
    return caseErrorResponse(err, 'views GET');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readObject(request);
    let viewId: string | null = null;
    if (body.viewId !== undefined && body.viewId !== null) {
      // A non-uuid id names no view; never sent to Postgres (22P02).
      if (!isUuid(body.viewId))
        throw new CaseHttpError(404, 'View not found', {
          code: 'VIEW_NOT_FOUND',
        });
      viewId = body.viewId;
    }
    if (
      body.shared !== undefined &&
      body.shared !== null &&
      typeof body.shared !== 'boolean'
    )
      throw badRequest('shared must be true or false');
    const view = await caseViews().save(ctx.userId, {
      viewId,
      name: body.name,
      filters: body.filters,
      sort: body.sort,
      shared: body.shared === true,
    });
    return NextResponse.json({ view });
  } catch (err) {
    return caseErrorResponse(err, 'views POST');
  }
}
