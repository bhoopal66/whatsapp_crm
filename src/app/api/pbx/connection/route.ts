// ============================================================
// /api/pbx/connection — the workspace's Yeastar PBX (migration 089)
//
//   GET — non-secret fields, which secrets are set, the webhook URL to
//         paste into Yeastar, mapped-extension and softphone counts.
//   PUT — { label, edition, baseUrl, apiPath?, clientId, clientSecret?,
//         sdkAccessId?, sdkAccessKey?, webhookSecret? }. Creates or
//         updates. An omitted secret keeps the stored one; null clears
//         an SDK credential or the webhook secret. Changing credentials
//         or the address empties the token caches and the backoff.
//
// Admin+. Secrets are written with the service role and never returned.
// ============================================================

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ownConnection,
  pbxServiceDb,
  pbxWebhookUrl,
  type OwnConnectionRow,
} from '@/lib/pbx/admin';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

const EDITIONS = ['cloud', 'software', 'appliance'] as const;
const SECRET_FIELDS = [
  ['sdkAccessId', 'sdk_access_id_enc'],
  ['sdkAccessKey', 'sdk_access_key_enc'],
  ['webhookSecret', 'webhook_secret_enc'],
] as const;

interface Input {
  label: string;
  edition: (typeof EDITIONS)[number];
  baseUrl: string;
  apiPath: string;
  clientId: string;
  clientSecret?: string;
  sdkAccessId?: string | null;
  sdkAccessKey?: string | null;
  webhookSecret?: string | null;
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() && v.trim().length <= max
    ? v.trim()
    : null;
}

function parse(b: Record<string, unknown>): Input | string {
  const label = text(b.label, 100);
  if (!label) return 'label is required (at most 100 characters)';
  const edition = EDITIONS.find((e) => e === b.edition);
  if (!edition) return 'edition must be cloud, software or appliance';
  let url: URL;
  try {
    url = new URL(String(b.baseUrl ?? ''));
  } catch {
    return 'baseUrl must be a URL';
  }
  const httpsOnly = edition === 'cloud';
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) {
    return httpsOnly
      ? 'baseUrl must be https:// for Yeastar Cloud'
      : 'baseUrl must be http:// or https://';
  }
  if (url.username || url.password) return 'baseUrl must not carry credentials';
  const apiPath =
    b.apiPath === undefined
      ? 'openapi/v1.0'
      : text(b.apiPath, 100)?.replace(/^\/+|\/+$/g, '');
  if (!apiPath || !/^[A-Za-z0-9._/-]+$/.test(apiPath))
    return 'apiPath is invalid';
  const clientId = text(b.clientId, 200);
  if (!clientId) return 'clientId is required';
  const input: Input = {
    label,
    edition,
    baseUrl: url.origin,
    apiPath,
    clientId,
  };
  if (b.clientSecret !== undefined) {
    const s = text(b.clientSecret, 500);
    if (!s) return 'clientSecret must be a non-empty string';
    input.clientSecret = s;
  }
  for (const [field] of SECRET_FIELDS) {
    const v = b[field];
    if (v === undefined) continue;
    if (v === null) input[field] = null;
    else if (text(v, 500)) input[field] = text(v, 500);
    else return `${field} must be a non-empty string or null`;
  }
  return input;
}

async function describe(db: SupabaseClient, c: OwnConnectionRow, url: string) {
  const [{ data: s }, mapped, softphone] = await Promise.all([
    db
      .from('pbx_connection_secrets')
      .select(
        'client_secret_enc, sdk_access_id_enc, sdk_access_key_enc, webhook_secret_enc'
      )
      .eq('connection_id', c.id)
      .maybeSingle(),
    db
      .from('pbx_extensions')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', c.id)
      .not('user_id', 'is', null),
    db
      .from('pbx_extensions')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', c.id)
      .not('user_id', 'is', null)
      .eq('softphone_enabled', true),
  ]);
  const set = (k: string) =>
    Boolean((s as Record<string, unknown> | null)?.[k]);
  return {
    id: c.id,
    label: c.label,
    edition: c.edition,
    baseUrl: c.base_url,
    apiPath: c.api_path,
    clientIdLast4: c.client_id_last4,
    firmware: c.firmware,
    status: c.status,
    lastEventAt: c.last_event_at,
    lastError: c.last_error,
    updatedAt: c.updated_at,
    webhookUrl: pbxWebhookUrl(c.webhook_path_token, url),
    hasClientSecret: set('client_secret_enc'),
    hasSdkCredentials: set('sdk_access_id_enc') && set('sdk_access_key_enc'),
    hasWebhookSecret: set('webhook_secret_enc'),
    mappedExtensions: mapped.count ?? 0,
    softphoneUsers: softphone.count ?? 0,
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const db = pbxServiceDb();
    const conn = await ownConnection(db, ctx.accountId);
    return NextResponse.json({
      connection: conn ? await describe(db, conn, request.url) : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function openOrNull(enc: unknown): string | null {
  try {
    return typeof enc === 'string' && enc ? decrypt(enc) : null;
  } catch {
    return null;
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null)
      return bad('Invalid JSON body');
    const input = parse(body as Record<string, unknown>);
    if (typeof input === 'string') return bad(input);

    const db = pbxServiceDb();
    const existing = await ownConnection(db, ctx.accountId);
    const { data: stored, error: readError } = existing
      ? await db
          .from('pbx_connection_secrets')
          .select('client_id_enc, client_secret_enc')
          .eq('connection_id', existing.id)
          .maybeSingle()
      : { data: null, error: null };
    if (readError)
      throw new Error(`pbx secrets read failed: ${readError.message}`);
    if (
      !input.clientSecret &&
      !(stored as { client_secret_enc?: string } | null)?.client_secret_enc
    ) {
      return bad('clientSecret is required');
    }

    const moved =
      !existing ||
      existing.base_url !== input.baseUrl ||
      existing.api_path !== input.apiPath;
    const apiChanged =
      moved ||
      input.clientSecret !== undefined ||
      openOrNull(
        (stored as { client_id_enc?: string } | null)?.client_id_enc
      ) !== input.clientId;
    const sdkChanged =
      moved ||
      input.sdkAccessId !== undefined ||
      input.sdkAccessKey !== undefined;

    const fields = {
      label: input.label,
      edition: input.edition,
      base_url: input.baseUrl,
      api_path: input.apiPath,
      client_id_last4: input.clientId.slice(-4),
      ...(apiChanged ? { status: 'unknown', last_error: null } : {}),
    };
    const { data: saved, error } = existing
      ? await db
          .from('pbx_connections')
          .update(fields)
          .eq('id', existing.id)
          .select('id')
          .single()
      : await db
          .from('pbx_connections')
          .insert({
            ...fields,
            account_id: ctx.accountId,
            created_by: ctx.userId,
            webhook_path_token: randomBytes(32).toString('hex'),
          })
          .select('id')
          .single();
    if (error || !saved)
      throw new Error(`pbx_connections write failed: ${error?.message}`);
    const id = (saved as { id: string }).id;

    // A new stamp (not NULL) makes any in-flight token swap lose.
    const stamp = new Date().toISOString();
    const secrets: Record<string, string | null> = {
      connection_id: id,
      client_id_enc: encrypt(input.clientId),
      updated_at: stamp,
    };
    if (input.clientSecret)
      secrets.client_secret_enc = encrypt(input.clientSecret);
    for (const [field, column] of SECRET_FIELDS) {
      const v = input[field];
      if (v !== undefined) secrets[column] = v === null ? null : encrypt(v);
    }
    if (apiChanged) {
      Object.assign(secrets, {
        token_cache_enc: null,
        token_cache_updated_at: stamp,
        backoff_until: null,
      });
    }
    if (sdkChanged) {
      Object.assign(secrets, {
        sdk_token_cache_enc: null,
        sdk_token_cache_updated_at: stamp,
      });
    }
    const { error: secretsError } = await db
      .from('pbx_connection_secrets')
      .upsert(secrets, { onConflict: 'connection_id' });
    if (secretsError) {
      if (!existing) await db.from('pbx_connections').delete().eq('id', id);
      throw new Error(`pbx secrets write failed: ${secretsError.message}`);
    }

    const conn = await ownConnection(db, ctx.accountId);
    return NextResponse.json({
      connection: conn ? await describe(db, conn, request.url) : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
