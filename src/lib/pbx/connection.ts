import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { createDbTokenCache } from './token-cache';
import {
  createSdkSignature,
  createTokenManager,
  createYeastarApi,
  createYeastarClient,
  type FetchFn,
  type TokenProvider,
  type YeastarApi,
  type YeastarClient,
} from './yeastar';

export type PbxConnectionErrorCode =
  | 'not_found'
  | 'no_credentials'
  | 'no_sdk_credentials'
  | 'undecryptable'
  | 'auth_backoff';

export class PbxConnectionError extends Error {
  readonly code: PbxConnectionErrorCode;
  constructor(code: PbxConnectionErrorCode, message: string) {
    super(message);
    this.name = 'PbxConnectionError';
    this.code = code;
  }
}

/**
 * How long every process leaves a connection alone after the PBX refused
 * its credentials or blocked our IP (`backoff_until`). Five failed logins
 * in a row get the server's IP blocked, and serverless instances do not
 * share the token manager's in-process backoff.
 */
export const PBX_AUTH_BACKOFF_MS = 5 * 60_000;

export interface PbxConnectionInfo {
  id: string;
  accountId: string;
  label: string;
  edition: 'cloud' | 'software' | 'appliance';
  baseUrl: string;
  apiPath: string;
  status: string;
  /** ISO time, or null when not backing off. */
  backoffUntil: string | null;
}

/** Decrypted. Server-only: never put any of it in a response or a log. */
export interface PbxCredentials extends PbxConnectionInfo {
  clientId: string;
  clientSecret: string;
  sdkAccessId: string | null;
  sdkAccessKey: string | null;
  webhookSecret: string | null;
}

export interface PbxHandle {
  connection: PbxConnectionInfo;
  client: YeastarClient;
  api: YeastarApi;
  tokens: TokenProvider;
}

export interface PbxSdkSigner {
  connection: PbxConnectionInfo;
  /** A Linkus SDK login signature for the extension user's email. */
  sign(username: string, expireTime?: number): Promise<string>;
}

interface Options {
  fetch?: FetchFn;
  now?: () => number;
}

function open(enc: unknown, connectionId: string): string | null {
  if (typeof enc !== 'string' || enc === '') return null;
  try {
    return decrypt(enc);
  } catch {
    throw new PbxConnectionError(
      'undecryptable',
      `PBX connection ${connectionId}: a stored secret cannot be decrypted (was ENCRYPTION_KEY changed?)`
    );
  }
}

/** `db` must be the service-role client: the secrets table has no policy. */
export async function loadPbxConnection(
  db: SupabaseClient,
  connectionId: string
): Promise<PbxCredentials> {
  const { data: row, error } = await db
    .from('pbx_connections')
    .select('id, account_id, label, edition, base_url, api_path, status')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`PBX connection read failed: ${error.message}`);
  if (!row) {
    throw new PbxConnectionError(
      'not_found',
      `PBX connection ${connectionId} not found`
    );
  }
  const { data: secrets, error: secretsError } = await db
    .from('pbx_connection_secrets')
    .select(
      'client_id_enc, client_secret_enc, sdk_access_id_enc, sdk_access_key_enc, webhook_secret_enc, backoff_until'
    )
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (secretsError) {
    throw new Error(`PBX secrets read failed: ${secretsError.message}`);
  }
  const s = (secrets ?? {}) as Record<string, unknown>;
  const clientId = open(s.client_id_enc, connectionId);
  const clientSecret = open(s.client_secret_enc, connectionId);
  if (!clientId || !clientSecret) {
    throw new PbxConnectionError(
      'no_credentials',
      `PBX connection ${connectionId} has no Client ID / Client Secret`
    );
  }
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    edition: row.edition,
    baseUrl: row.base_url,
    apiPath: row.api_path,
    status: row.status,
    backoffUntil: typeof s.backoff_until === 'string' ? s.backoff_until : null,
    clientId,
    clientSecret,
    sdkAccessId: open(s.sdk_access_id_enc, connectionId),
    sdkAccessKey: open(s.sdk_access_key_enc, connectionId),
    webhookSecret: open(s.webhook_secret_enc, connectionId),
  };
}

/**
 * The connection's decrypted webhook secret, or null when none is
 * stored. Reads only that secret: the webhook route needs nothing else.
 */
export async function loadPbxWebhookSecret(
  db: SupabaseClient,
  connectionId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('pbx_connection_secrets')
    .select('webhook_secret_enc')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`PBX secrets read failed: ${error.message}`);
  return open(
    (data as { webhook_secret_enc?: unknown } | null)?.webhook_secret_enc,
    connectionId
  );
}

function infoOf(c: PbxCredentials): PbxConnectionInfo {
  return {
    id: c.id,
    accountId: c.accountId,
    label: c.label,
    edition: c.edition,
    baseUrl: c.baseUrl,
    apiPath: c.apiPath,
    status: c.status,
    backoffUntil: c.backoffUntil,
  };
}

function refuseWhileBackingOff(c: PbxCredentials, now: () => number): void {
  if (c.backoffUntil && Date.parse(c.backoffUntil) > now()) {
    throw new PbxConnectionError(
      'auth_backoff',
      `PBX connection ${c.id} refused its credentials; retry after ${c.backoffUntil}`
    );
  }
}

/** The API client and calls for one connection, tokens cached in the DB. */
export async function pbxApiFor(
  db: SupabaseClient,
  connectionId: string,
  options: Options = {}
): Promise<PbxHandle> {
  const conn = await loadPbxConnection(db, connectionId);
  refuseWhileBackingOff(conn, options.now ?? Date.now);
  const target = { baseUrl: conn.baseUrl, apiPath: conn.apiPath };
  const tokens = createTokenManager({
    connection: {
      ...target,
      clientId: conn.clientId,
      clientSecret: conn.clientSecret,
    },
    cache: createDbTokenCache(db, conn.id, 'api'),
    fetch: options.fetch,
    now: options.now,
  });
  const client = createYeastarClient({
    connection: target,
    tokens,
    fetch: options.fetch,
  });
  return {
    connection: infoOf(conn),
    client,
    api: createYeastarApi(client),
    tokens,
  };
}

/** Linkus SDK signatures, on the SDK's own credentials and token cache. */
export async function sdkSignerFor(
  db: SupabaseClient,
  connectionId: string,
  options: Options = {}
): Promise<PbxSdkSigner> {
  const conn = await loadPbxConnection(db, connectionId);
  refuseWhileBackingOff(conn, options.now ?? Date.now);
  if (!conn.sdkAccessId || !conn.sdkAccessKey) {
    throw new PbxConnectionError(
      'no_sdk_credentials',
      `PBX connection ${connectionId} has no Linkus SDK AccessID / AccessKey`
    );
  }
  const target = { baseUrl: conn.baseUrl, apiPath: conn.apiPath };
  const sdkTokens = createTokenManager({
    connection: {
      ...target,
      clientId: conn.sdkAccessId,
      clientSecret: conn.sdkAccessKey,
    },
    cache: createDbTokenCache(db, conn.id, 'sdk'),
    fetch: options.fetch,
    now: options.now,
  });
  const client = createYeastarClient({
    connection: target,
    tokens: sdkTokens,
    fetch: options.fetch,
  });
  return {
    connection: infoOf(conn),
    sign: (username, expireTime) =>
      createSdkSignature({ client, sdkTokens, username, expireTime }),
  };
}

async function firstConnectionId(
  db: SupabaseClient,
  table: 'pbx_connections' | 'pbx_did_routes' | 'pbx_extensions',
  column: 'id' | 'connection_id',
  accountId: string
): Promise<string | null> {
  const { data, error } = await db
    .from(table)
    .select(column)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  const row = (data as Record<string, string>[] | null)?.[0];
  return row?.[column] ?? null;
}

/**
 * The connection that serves a workspace: the one it configured, else
 * one that routes a dialled number to it, else one with an extension in
 * it (oldest first at each step). Null when no PBX reaches it.
 */
export async function connectionForAccount(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  return (
    (await firstConnectionId(db, 'pbx_connections', 'id', accountId)) ??
    (await firstConnectionId(
      db,
      'pbx_did_routes',
      'connection_id',
      accountId
    )) ??
    (await firstConnectionId(db, 'pbx_extensions', 'connection_id', accountId))
  );
}
