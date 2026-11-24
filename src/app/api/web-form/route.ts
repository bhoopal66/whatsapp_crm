// ============================================================
// GET / PUT /api/web-form — Settings → Web form (migration 249,
// docs/web-form.md). Owner/admin. Both go through the caller's own
// session to web_form_get / web_form_set, which check the role in the
// caller's ACTIVE workspace again; the token is generated there.
//
// PUT body: { enabled?: boolean, allowedOrigins?: string[], rotate?: boolean }
// A field left out keeps what is stored (read through web_form_get), so
// "Rotate key" from a stale tab sends only { rotate: true } and cannot write
// that tab's old switch and origins back. An empty body is a 400.
// -> 200 { enabled, token, allowed_origins, updated_at }; 400 for a bad
// body or an origin that is not https://host[:port] (the same rule as
// the SQL), 403 below admin.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MAX_ALLOWED_ORIGINS,
  normalizeAllowedOrigin,
} from '@/lib/web-form/origin';

export const dynamic = 'force-dynamic';

function rpcFailure(error: { code?: string; hint?: string; message?: string }) {
  if (error.code === '42501') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (error.code === '22023') {
    return NextResponse.json(
      { error: error.hint || 'bad_settings' },
      { status: 400 }
    );
  }
  console.error('[web-form] settings rpc failed:', error.message);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase.rpc('web_form_get');
    if (error) return rpcFailure(error);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'bad_body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const hasEnabled = b.enabled !== undefined;
    const hasOrigins = b.allowedOrigins !== undefined;
    if (
      (hasEnabled && typeof b.enabled !== 'boolean') ||
      (hasOrigins && !Array.isArray(b.allowedOrigins)) ||
      (b.rotate !== undefined && typeof b.rotate !== 'boolean') ||
      (!hasEnabled && !hasOrigins && b.rotate !== true)
    ) {
      return NextResponse.json({ error: 'bad_body' }, { status: 400 });
    }
    let enabled = b.enabled as boolean | undefined;
    let rawOrigins = b.allowedOrigins as unknown[] | undefined;
    if (enabled === undefined || rawOrigins === undefined) {
      const { data: current, error: getError } =
        await ctx.supabase.rpc('web_form_get');
      if (getError) return rpcFailure(getError);
      const cur = (current ?? {}) as {
        enabled?: unknown;
        allowed_origins?: unknown;
      };
      enabled ??= cur.enabled === true;
      rawOrigins ??= Array.isArray(cur.allowed_origins)
        ? cur.allowed_origins
        : [];
    }
    if (rawOrigins.length > MAX_ALLOWED_ORIGINS) {
      return NextResponse.json({ error: 'too_many_origins' }, { status: 400 });
    }
    const origins: string[] = [];
    for (const raw of rawOrigins) {
      const origin =
        typeof raw === 'string' ? normalizeAllowedOrigin(raw) : null;
      if (!origin) {
        return NextResponse.json({ error: 'bad_origin' }, { status: 400 });
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    const { data, error } = await ctx.supabase.rpc('web_form_set', {
      p_enabled: enabled,
      p_allowed_origins: origins,
      p_rotate: b.rotate === true,
    });
    if (error) return rpcFailure(error);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
