// ============================================================
// OpenWA numbers, server side: connect, live status and disconnect.
//
// Shared by the admin routes (`/api/whatsapp/config/openwa/*`, a shared
// number, on the caller's RLS client) and the self-service ones
// (`/api/whatsapp/personal/*`, a person's own number, on the service
// role once the route has checked who may touch it). Each route decides
// who the caller is and which row they may name; everything after that
// is the same, so it lives here once.
// ============================================================

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from './encryption';
import {
  OpenWAError,
  createScopedKey,
  createSession,
  createWebhook,
  deleteSession,
  findScopedKeyIds,
  getQr,
  getSession,
  openwaAdminApiKey,
  openwaWebhookBaseUrl,
  revokeKey,
  startSession,
  updateWebhookEvents,
} from './openwa-api';
import { teardownOpenWASession } from './openwa-cleanup';
import { promoteOldestToPrimary } from './personal-numbers';
import { generateWebhookSecret } from './whapi-webhook-auth';

/** A failure the connect turns into its own answer (after the undo). */
class ConnectRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

/**
 * Connect a number on the self-hosted OpenWA gateway. One action, in
 * this order: create the session, mint an operator key scoped to it,
 * point its webhook at the CRM, start it, save the row. The QR comes
 * later from the status probe. The admin key stays in the environment;
 * the row holds only the scoped key and the webhook secret, both
 * encrypted (row mapping: migration 144).
 *
 * Anything that fails after the session exists undoes the gateway side
 * (revoke the key, delete the session), because an orphan session keeps
 * an engine running and a key that can drive it.
 *
 * `personal` saves the person's own number (migration 190): never the
 * default, owned by `userId`. A shared number is the default when it is
 * the account's first shared one; personal numbers do not count.
 *
 * Answers `{ configId }`, or `{ error }` with 503 `openwa_not_configured`,
 * 409 `already_connected` (personal: the one-per-person index), 403
 * `not_allowed` (personal: 190's PERSONAL_NOT_ALLOWED refusal), 502 for
 * a gateway refusal and 500 otherwise.
 */
export async function connectOpenWANumber(args: {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  label: string;
  personal: boolean;
}): Promise<NextResponse> {
  const { db, accountId, userId, label, personal } = args;
  const adminKey = openwaAdminApiKey();
  if (!adminKey) {
    return NextResponse.json(
      { error: 'openwa_not_configured' },
      { status: 503 }
    );
  }

  let sessionId: string | null = null;
  let keyId: string | null = null;
  try {
    // A random name: OpenWA names are unique gateway-wide, and the label
    // a person types is neither unique nor in OpenWA's [a-z0-9-] alphabet.
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

    let isPrimary = false;
    if (!personal) {
      // First shared number in the account becomes the primary, as on
      // the Whapi connect path: the one-primary index (046) refuses a
      // second. Personal numbers can never be it (190).
      const { count: siblingCount } = await db
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('is_personal', false);
      isPrimary = (siblingCount ?? 0) === 0;
    }
    const newRow = {
      account_id: accountId,
      user_id: userId,
      provider: 'openwa',
      label: label || (personal ? 'Personal WhatsApp' : 'WhatsApp (OpenWA)'),
      is_primary: isPrimary,
      ...(personal ? { is_personal: true } : {}),
      phone_number_id: sessionId,
      access_token: encrypt(key.apiKey),
      verify_token: encrypt(secret),
      // Filled with the number once the phone links (status probe).
      waba_id: null,
      status: 'disconnected',
    };
    let { data: inserted, error: insertError } = await db
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
      ({ data: inserted, error: insertError } = await db
        .from('whatsapp_config')
        .insert({ ...newRow, is_primary: false })
        .select('id')
        .single());
    }
    // Two personal connects at once: the one-per-person index keeps the
    // first, and this one's session is undone below.
    if (personal && insertError?.code === '23505') {
      throw new ConnectRefused(409, 'already_connected');
    }
    // The permission was revoked (or the person deactivated) between the
    // route's check and this insert: 190's trigger has the last word.
    if (insertError?.hint === 'PERSONAL_NOT_ALLOWED') {
      throw new ConnectRefused(403, 'not_allowed');
    }
    if (insertError || !inserted?.id) {
      throw new Error(
        `whatsapp_config insert failed: ${insertError?.message ?? 'no id'}`
      );
    }

    return NextResponse.json({ configId: inserted.id as string });
  } catch (err) {
    console.error('[openwa connect] failed:', err);
    const clean = sessionId
      ? await undoGatewaySide(adminKey, sessionId, keyId)
      : true;
    if (err instanceof ConnectRefused) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    return NextResponse.json(
      { error: explainConnectFailure(err, clean) },
      { status: err instanceof OpenWAError ? 502 : 500 }
    );
  }
}

/**
 * Best effort: each step is logged and never masks the original error.
 * Returns whether everything was removed.
 *
 * With no key id the mint may still have succeeded (its answer lost to a
 * timeout, or missing its id), leaving a live operator key for this
 * session; find it by the name the mint gives it and revoke that.
 */
async function undoGatewaySide(
  adminKey: string,
  sessionId: string,
  keyId: string | null
): Promise<boolean> {
  let clean = true;
  let keyIds: string[] = keyId ? [keyId] : [];
  if (!keyId) {
    try {
      keyIds = await findScopedKeyIds({ adminKey, sessionId });
    } catch (e) {
      clean = false;
      console.error('[openwa connect] cleanup: key lookup failed:', e);
    }
  }
  for (const id of keyIds) {
    try {
      await revokeKey({ adminKey, keyId: id });
    } catch (e) {
      clean = false;
      console.error('[openwa connect] cleanup: revoke key failed:', e);
    }
  }
  try {
    await deleteSession({ adminKey, sessionId });
  } catch (e) {
    clean = false;
    console.error('[openwa connect] cleanup: delete session failed:', e);
  }
  return clean;
}

function explainConnectFailure(err: unknown, clean: boolean): string {
  const leftover = clean
    ? ''
    : ' Part of it may be left on the OpenWA gateway; an admin can remove it from the OpenWA dashboard.';
  if (err instanceof OpenWAError) {
    if (err.isAuthError) {
      return (
        'The OpenWA gateway refused this server’s admin key (OPENWA_API_KEY).' +
        leftover
      );
    }
    if (err.status === 503) {
      return (
        'The OpenWA gateway is not reachable. Check that it is running.' +
        leftover
      );
    }
    return `The OpenWA gateway refused the connection: ${err.message}.${leftover}`;
  }
  return clean
    ? 'The number could not be saved. Nothing was left on the gateway.'
    : 'The number could not be saved.' + leftover;
}

const ROW_COLUMNS =
  'id, phone_number_id, access_token, waba_id, status, connected_at, is_personal';

export interface OpenWARow {
  id: string;
  phone_number_id: string | null;
  access_token: string | null;
  waba_id: string | null;
  status: string | null;
  connected_at: string | null;
  is_personal?: boolean | null;
}

/**
 * One OpenWA row of the account, or null. With `ownerId` only that
 * person's personal number matches: anyone else's, and every shared
 * number, read as absent, so the self-service routes answer 404.
 */
export async function loadOpenWARow(
  db: SupabaseClient,
  args: { accountId: string; configId: string; ownerId?: string }
): Promise<OpenWARow | null> {
  let query = db
    .from('whatsapp_config')
    .select(ROW_COLUMNS)
    .eq('account_id', args.accountId)
    .eq('provider', 'openwa')
    .eq('id', args.configId);
  if (args.ownerId !== undefined) {
    query = query.eq('is_personal', true).eq('user_id', args.ownerId);
  }
  const { data } = await query.maybeSingle();
  return (data as OpenWARow | null) ?? null;
}

/**
 * The live state of a number, what the connect dialog polls: `{ status,
 * qrCode?, phone? }` in OpenWA's own words. Uses the row's scoped key,
 * never the admin key, so a row can only ever ask about its own session.
 *
 * On `ready` it writes `connected`, the number and `connected_at` for
 * the FIRST link only (`connected_at IS NULL`). After that the row's
 * status belongs to the health sweep alone: the Settings list calls this
 * to show live state, and a write here would flip a number that went
 * down back to 'connected' silently, so the sweep would never see the
 * transition and owners would never get the "connected again" alert.
 * The answer still carries the live state either way.
 *
 * The number (`waba_id`) is not status, so it follows the phone after
 * the first link too: written alone, never with `status`, whenever the
 * session reports a different phone. A first link the health sweep
 * stamped without a phone, or a re-link to another handset, would
 * otherwise show the old number (or none) forever.
 */
/** Rows whose webhook already carries every event, this process. */
const eventsChecked = new Set<string>();

/**
 * A personal number connected before `message.sent` was subscribed gets
 * it here, once per process per number: the probe runs while its owner
 * has Settings open, which is when a missing mirror would be noticed.
 * Best-effort; a failure is retried on the next probe.
 */
async function ensureOwnSendEvents(
  rowId: string,
  creds: { apiKey: string; sessionId: string }
): Promise<void> {
  if (eventsChecked.has(rowId)) return;
  try {
    await updateWebhookEvents(creds);
    eventsChecked.add(rowId);
  } catch (err) {
    console.warn('[openwa status] webhook event update failed:', err);
  }
}

export async function probeOpenWANumber(
  db: SupabaseClient,
  accountId: string,
  row: OpenWARow
): Promise<NextResponse> {
  let creds: { apiKey: string; sessionId: string };
  try {
    creds = {
      apiKey: decrypt(row.access_token as string),
      sessionId: row.phone_number_id as string,
    };
  } catch {
    return NextResponse.json(
      {
        error:
          'The stored OpenWA key cannot be read. Disconnect and reconnect.',
      },
      { status: 500 }
    );
  }

  try {
    const session = await getSession(creds);
    if (session.status === 'qr_ready') {
      // The QR can rotate between the two calls; a missing one just
      // waits for the next poll.
      const qr = await getQr(creds).catch(() => null);
      return NextResponse.json({
        status: session.status,
        ...(qr?.qrCode ? { qrCode: qr.qrCode } : {}),
      });
    }
    if (session.status === 'ready') {
      if (row.is_personal === true) await ensureOwnSendEvents(row.id, creds);
      if (row.connected_at == null) {
        const { error } = await db
          .from('whatsapp_config')
          .update({
            status: 'connected',
            waba_id: session.phone ?? row.waba_id,
            connected_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
          .eq('id', row.id)
          // The sweep may have stamped the first link a moment ago.
          .is('connected_at', null);
        if (error) console.error('[openwa status] update failed:', error);
      } else if (
        session.phone &&
        session.phone !== (row.waba_id ?? '').replace(/\D/g, '')
      ) {
        let update = db
          .from('whatsapp_config')
          .update({ waba_id: session.phone })
          .eq('account_id', accountId)
          .eq('id', row.id);
        // Conditional on the number it replaces, so a concurrent write wins.
        update = row.waba_id
          ? update.eq('waba_id', row.waba_id)
          : update.is('waba_id', null);
        const { error } = await update;
        if (error)
          console.error('[openwa status] number update failed:', error);
      }
      return NextResponse.json({
        status: session.status,
        ...(session.phone ? { phone: session.phone } : {}),
      });
    }
    return NextResponse.json({ status: session.status });
  } catch (err) {
    console.error('[openwa status] probe failed:', err);
    const status = err instanceof OpenWAError ? 502 : 500;
    return NextResponse.json(
      { error: 'The OpenWA gateway did not answer. Try again shortly.' },
      { status }
    );
  }
}

/**
 * Disconnect a number. The gateway side is best effort, each step
 * logged: unlink the phone, delete the session, revoke its scoped key.
 * Then the row goes the way the Whapi DELETE removes a number: its
 * routes and allocations cascade, its chat history stays (`channel_id`
 * goes NULL), and if it was the primary the oldest remaining shared
 * number is promoted.
 *
 * Without OPENWA_API_KEY the row is still removed, so an install that
 * dropped OpenWA can clean up; the gateway side is then left alone.
 *
 * Answers `{ ok: true, gatewayCleanup }`. The row goes either way, but
 * when the gateway could not be reached (or there is no admin key) the
 * session may still be running a browser with a working key, and only
 * an admin can finish the job in the OpenWA dashboard: 'incomplete' is
 * how the screen knows to say so.
 */
export async function disconnectOpenWANumber(
  db: SupabaseClient,
  accountId: string,
  row: Pick<OpenWARow, 'id' | 'phone_number_id'>
): Promise<NextResponse> {
  const sessionId = row.phone_number_id;
  const adminKey = openwaAdminApiKey();
  // No session id means nothing was ever created on the gateway (the
  // create failed before it stored one): there is nothing to finish.
  const gatewayCleanup = !sessionId
    ? 'complete'
    : adminKey &&
        (await teardownOpenWASession({
          adminKey,
          sessionId,
          logPrefix: '[openwa disconnect]',
        }))
      ? 'complete'
      : 'incomplete';

  const { error: deleteError } = await db
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('id', row.id);
  if (deleteError) {
    console.error('[openwa disconnect] delete row failed:', deleteError);
    return NextResponse.json(
      { error: 'Failed to delete configuration' },
      { status: 500 }
    );
  }

  await promoteOldestToPrimary(db, accountId);

  return NextResponse.json({ ok: true, gatewayCleanup });
}
