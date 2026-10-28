import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  OpenWAError,
  createScopedKey,
  createSession,
  createWebhook,
  deleteSession,
  openwaAdminApiKey,
  openwaWebhookBaseUrl,
  revokeKey,
  startSession,
} from '@/lib/whatsapp/openwa-api';
import { generateWebhookSecret } from '@/lib/whatsapp/whapi-webhook-auth';

/**
 * POST /api/whatsapp/config/openwa — connect a number on the self-hosted
 * OpenWA gateway. Admin+, like every other WhatsApp connection route.
 *
 * One action, in this order: create the session, mint an operator key
 * scoped to it, point its webhook at the CRM, start it, save the row.
 * The QR comes later from `[configId]/status`. The admin key stays in
 * the environment; the row holds only the scoped key and the webhook
 * secret, both encrypted (row mapping: migration 144).
 *
 * Anything that fails after the session exists undoes the gateway side
 * (revoke the key, delete the session), because an orphan session keeps
 * an engine running and a key that can drive it.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const adminKey = openwaAdminApiKey();
  if (!adminKey) {
    return NextResponse.json(
      { error: 'openwa_not_configured' },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
  };
  const label =
    typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';

  let sessionId: string | null = null;
  let keyId: string | null = null;
  try {
    // A random name: OpenWA names are unique gateway-wide, and the label
    // an admin types is neither unique nor in OpenWA's [a-z0-9-] alphabet.
    const session = await createSession({
      adminKey,
      name: `wacrm-${randomBytes(6).toString('hex')}`,
    });
    sessionId = session.id;

    const key = await createScopedKey({ adminKey, sessionId });
    keyId = key.id;

    const secret = generateWebhookSecret();
    await createWebhook({
      adminKey,
      sessionId,
      url: `${openwaWebhookBaseUrl()}/api/whatsapp/openwa/webhook`,
      secret,
    });

    await startSession({ adminKey, sessionId });

    const { supabase, accountId, userId } = ctx;
    // First number in the account becomes the primary, as on the Whapi
    // connect path: the one-primary index (046) refuses a second.
    const { count: siblingCount } = await supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    const newRow = {
      account_id: accountId,
      user_id: userId,
      provider: 'openwa',
      label: label || 'WhatsApp (OpenWA)',
      is_primary: (siblingCount ?? 0) === 0,
      phone_number_id: sessionId,
      access_token: encrypt(key.apiKey),
      verify_token: encrypt(secret),
      // Filled with the number once the phone links (status route).
      waba_id: null,
      status: 'disconnected',
    };
    let { data: inserted, error: insertError } = await supabase
      .from('whatsapp_config')
      .insert(newRow)
      .select('id')
      .single();
    // Two first-connects at once both counted zero siblings; keep the
    // second as a non-default number rather than losing it.
    if (
      insertError?.code === '23505' &&
      insertError.message.includes('idx_whatsapp_config_one_primary')
    ) {
      ({ data: inserted, error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ ...newRow, is_primary: false })
        .select('id')
        .single());
    }
    if (insertError || !inserted?.id) {
      throw new Error(
        `whatsapp_config insert failed: ${insertError?.message ?? 'no id'}`
      );
    }

    return NextResponse.json({ configId: inserted.id as string });
  } catch (err) {
    console.error('[openwa connect] failed:', err);
    if (sessionId) await undoGatewaySide(adminKey, sessionId, keyId);
    return NextResponse.json(
      { error: explainConnectFailure(err) },
      { status: err instanceof OpenWAError ? 502 : 500 }
    );
  }
}

/** Best effort: each step is logged and never masks the original error. */
async function undoGatewaySide(
  adminKey: string,
  sessionId: string,
  keyId: string | null
): Promise<void> {
  if (keyId) {
    await revokeKey({ adminKey, keyId }).catch((e) =>
      console.error('[openwa connect] cleanup: revoke key failed:', e)
    );
  }
  await deleteSession({ adminKey, sessionId }).catch((e) =>
    console.error('[openwa connect] cleanup: delete session failed:', e)
  );
}

function explainConnectFailure(err: unknown): string {
  if (err instanceof OpenWAError) {
    if (err.isAuthError) {
      return 'The OpenWA gateway refused this server’s admin key (OPENWA_API_KEY).';
    }
    if (err.status === 503) {
      return 'The OpenWA gateway is not reachable. Check that it is running.';
    }
    return `The OpenWA gateway refused the connection: ${err.message}`;
  }
  return 'The number could not be saved. Nothing was left on the gateway.';
}
