// ============================================================
// POST /api/push/subscribe — register this browser for web push
// (migration 109). Insert under the caller's RLS client; an endpoint
// that already exists (another login on this browser, or the caller's
// own with rotated keys) is taken over with a service-role upsert,
// because push_subscriptions grants no UPDATE to clients.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const MAX_USER_AGENT = 512;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_KEY &&
    BASE64URL.test(value)
  );
}

export async function POST(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown } | null;
      userAgent?: unknown;
    } | null;
    if (!body || !isHttpsUrl(body.endpoint)) {
      return NextResponse.json(
        { error: 'endpoint must be an https URL' },
        { status: 400 }
      );
    }
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (!isKey(p256dh) || !isKey(auth)) {
      return NextResponse.json(
        { error: 'keys.p256dh and keys.auth must be base64url' },
        { status: 400 }
      );
    }
    const userAgent =
      typeof body.userAgent === 'string' && body.userAgent
        ? body.userAgent.slice(0, MAX_USER_AGENT)
        : null;

    const row = {
      user_id: userId,
      endpoint: body.endpoint,
      p256dh,
      auth,
      user_agent: userAgent,
    };
    const { error } = await supabase.from('push_subscriptions').insert(row);
    if (error && error.code === '23505') {
      const { error: upsertErr } = await supabaseAdmin()
        .from('push_subscriptions')
        .upsert({ ...row, failure_count: 0 }, { onConflict: 'endpoint' });
      if (upsertErr) {
        console.error('[push/subscribe] takeover failed:', upsertErr);
        return NextResponse.json(
          { error: 'Failed to save subscription' },
          { status: 500 }
        );
      }
    } else if (error) {
      console.error('[push/subscribe] insert failed:', error);
      return NextResponse.json(
        { error: 'Failed to save subscription' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
