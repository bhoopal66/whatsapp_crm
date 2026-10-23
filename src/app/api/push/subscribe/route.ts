// ============================================================
// POST /api/push/subscribe — register this browser for web push
// (migration 109). Insert under the caller's RLS client. An endpoint
// that already exists is updated with the service role (clients have no
// UPDATE grant on push_subscriptions), but only when the row is the
// caller's own (keys refreshed) or carries the very keys posted, which
// only the browser holding that subscription has (another login on the
// same browser). Anyone else posting a known endpoint gets 409: an
// endpoint alone must not redirect someone's notifications.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isKnownPushEndpoint } from '@/lib/push/endpoint';

const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const MAX_USER_AGENT = 512;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// Only a browser vendor's push service: dispatch POSTs to this URL from
// the server, so an arbitrary https host would be a blind SSRF.
function isPushEndpoint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ENDPOINT &&
    isKnownPushEndpoint(value)
  );
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
    if (!body || !isPushEndpoint(body.endpoint)) {
      return NextResponse.json(
        { error: 'endpoint must be a browser push service https URL' },
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
      return await takeOver(row);
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

interface SubscriptionRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

const saveFailed = () =>
  NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
const someoneElses = () =>
  NextResponse.json(
    {
      error:
        'This device is registered to someone else; turn notifications off and on again',
    },
    { status: 409 }
  );

async function takeOver(row: SubscriptionRow): Promise<Response> {
  const admin = supabaseAdmin();
  const { data: existing, error: readErr } = await admin
    .from('push_subscriptions')
    .select('user_id, p256dh, auth')
    .eq('endpoint', row.endpoint)
    .maybeSingle();
  if (readErr) {
    console.error('[push/subscribe] takeover read failed:', readErr);
    return saveFailed();
  }
  if (!existing) {
    // Deleted since the insert collided: nobody holds it now.
    const { error } = await admin
      .from('push_subscriptions')
      .upsert({ ...row, failure_count: 0 }, { onConflict: 'endpoint' });
    if (error) {
      console.error('[push/subscribe] takeover failed:', error);
      return saveFailed();
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  }
  const held = existing as { user_id: string; p256dh: string; auth: string };
  const sameKeys = held.p256dh === row.p256dh && held.auth === row.auth;
  if (held.user_id !== row.user_id && !sameKeys) return someoneElses();
  // Conditional on the row read, so a concurrent change is not
  // overwritten on the strength of a stale check.
  const { data: updated, error } = await admin
    .from('push_subscriptions')
    .update({ ...row, failure_count: 0 })
    .eq('endpoint', row.endpoint)
    .eq('user_id', held.user_id)
    .eq('p256dh', held.p256dh)
    .eq('auth', held.auth)
    .select('id');
  if (error) {
    console.error('[push/subscribe] takeover failed:', error);
    return saveFailed();
  }
  if (!updated || updated.length === 0) return someoneElses();
  return NextResponse.json({ ok: true }, { status: 201 });
}
