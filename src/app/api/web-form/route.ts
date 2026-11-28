// ============================================================
// GET / PUT /api/web-form — Settings → Web form (migration 249,
// docs/web-form.md). Owner/admin. Both go through the caller's own
// session to web_form_get / web_form_set, which check the role in the
// caller's ACTIVE workspace again; the token is generated there.
//
// PUT body: { enabled: boolean, allowedOrigins: string[], rotate?: boolean }
// -> 200 { enabled, token, allowed_origins, updated_at }; 400 for a bad
// body or an origin that is not http(s)://host[:port] (the same rule as
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
    if (typeof b.enabled !== 'boolean' || !Array.isArray(b.allowedOrigins)) {
      return NextResponse.json({ error: 'bad_body' }, { status: 400 });
    }
    if (b.allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
      return NextResponse.json({ error: 'too_many_origins' }, { status: 400 });
    }
    const origins: string[] = [];
    for (const raw of b.allowedOrigins) {
      const origin =
        typeof raw === 'string' ? normalizeAllowedOrigin(raw) : null;
      if (!origin) {
        return NextResponse.json({ error: 'bad_origin' }, { status: 400 });
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    const { data, error } = await ctx.supabase.rpc('web_form_set', {
      p_enabled: b.enabled,
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
