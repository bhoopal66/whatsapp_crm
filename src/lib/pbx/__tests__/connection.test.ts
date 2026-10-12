import { describe, expect, it } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  PbxConnectionError,
  connectionForAccount,
  loadPbxConnection,
  pbxApiFor,
  sdkSignerFor,
} from '../connection';
import { BASE, endpointOf, fakeFetch } from '../yeastar/__tests__/fixtures';
import { createFakeDb, type Row } from './fake-db';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const TOKEN_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  access_token: 'tok',
  access_token_expire_time: 1800,
  refresh_token: 'ref',
  refresh_token_expire_time: 86400,
};

function setup(secrets: Row = {}) {
  const fake = createFakeDb({
    pbx_connections: [
      {
        id: 'c1',
        account_id: 'acct-1',
        label: 'Main PBX',
        edition: 'cloud',
        base_url: BASE,
        api_path: 'openapi/v1.0',
        status: 'unknown',
      },
    ],
    pbx_connection_secrets: [
      {
        connection_id: 'c1',
        client_id_enc: encrypt('client-id'),
        client_secret_enc: encrypt('client-secret'),
        sdk_access_id_enc: encrypt('sdk-id'),
        sdk_access_key_enc: encrypt('sdk-key'),
        token_cache_updated_at: null,
        sdk_token_cache_updated_at: null,
        ...secrets,
      },
    ],
  });
  fake.rpcs.pbx_token_swap = (args) => {
    const row = fake.tables.pbx_connection_secrets[0];
    const col = args.p_kind === 'sdk' ? 'sdk_token_cache' : 'token_cache';
    row[`${col}_enc`] = args.p_new_enc;
    row[`${col}_updated_at`] = '2026-10-12T08:00:00.001Z';
    return { data: true, error: null };
  };
  return fake;
}

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e) => (e instanceof PbxConnectionError ? e.code : String(e))
  );

describe('loadPbxConnection', () => {
  it('decrypts the credentials', async () => {
    const c = await loadPbxConnection(setup().db, 'c1');
    expect(c).toMatchObject({
      id: 'c1',
      accountId: 'acct-1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sdkAccessId: 'sdk-id',
      webhookSecret: null,
    });
  });

  it('throws typed errors for a missing row, missing or undecryptable credentials', async () => {
    expect(await code(loadPbxConnection(setup().db, 'nope'))).toBe('not_found');
    expect(
      await code(loadPbxConnection(setup({ client_secret_enc: null }).db, 'c1'))
    ).toBe('no_credentials');
    expect(
      await code(
        loadPbxConnection(setup({ client_id_enc: 'garbage' }).db, 'c1')
      )
    ).toBe('undecryptable');
  });
});

describe('pbxApiFor', () => {
  it('mints with the API credentials and caches the token in the DB', async () => {
    const fake = setup();
    const { fetch, calls } = fakeFetch((call) =>
      endpointOf(call) === 'get_token'
        ? TOKEN_OK
        : { errcode: 0, errmsg: 'SUCCESS', total_number: 3, data: [] }
    );
    const { api, connection } = await pbxApiFor(fake.db, 'c1', {
      fetch,
      now: () => NOW,
    });
    expect(await api.testConnection()).toEqual({ ok: true, extensionCount: 3 });
    expect(calls.map(endpointOf)).toEqual(['get_token', 'extension/list']);
    expect(calls[0].body).toEqual({
      username: 'client-id',
      password: 'client-secret',
    });
    expect(calls[1].url.searchParams.get('access_token')).toBe('tok');
    expect(fake.tables.pbx_connection_secrets[0].token_cache_enc).toBeTruthy();
    expect(
      fake.tables.pbx_connection_secrets[0].sdk_token_cache_enc
    ).toBeUndefined();
    expect(JSON.stringify(connection)).not.toContain('client-secret');
  });

  it('refuses to touch the PBX while the connection is backing off', async () => {
    const fake = setup({ backoff_until: '2026-10-12T08:03:00Z' });
    const { fetch, calls } = fakeFetch(() => TOKEN_OK);
    expect(
      await code(pbxApiFor(fake.db, 'c1', { fetch, now: () => NOW }))
    ).toBe('auth_backoff');
    expect(calls).toHaveLength(0);
  });
});

describe('sdkSignerFor', () => {
  it('signs with the SDK credentials and the sdk token cache', async () => {
    const fake = setup();
    const { fetch, calls } = fakeFetch((call) =>
      endpointOf(call) === 'get_token'
        ? TOKEN_OK
        : { errcode: 0, errmsg: 'SUCCESS', data: { sign: 'signed' } }
    );
    const signer = await sdkSignerFor(fake.db, 'c1', { fetch, now: () => NOW });
    expect(await signer.sign('agent@example.com')).toBe('signed');
    expect(calls[0].body).toEqual({ username: 'sdk-id', password: 'sdk-key' });
    expect(calls[1].body).toMatchObject({
      username: 'agent@example.com',
      sign_type: 'sdk',
    });
    expect(
      fake.tables.pbx_connection_secrets[0].sdk_token_cache_enc
    ).toBeTruthy();
    expect(
      fake.tables.pbx_connection_secrets[0].token_cache_enc
    ).toBeUndefined();
  });

  it('throws no_sdk_credentials without an AccessID / AccessKey', async () => {
    const fake = setup({ sdk_access_key_enc: null });
    expect(await code(sdkSignerFor(fake.db, 'c1'))).toBe('no_sdk_credentials');
  });
});

describe('connectionForAccount', () => {
  it("prefers the workspace's own connection, then a DID route, then an extension", async () => {
    const fake = createFakeDb({
      pbx_connections: [{ id: 'own', account_id: 'a', created_at: '1' }],
      pbx_did_routes: [
        { connection_id: 'via-did', account_id: 'b', created_at: '1' },
      ],
      pbx_extensions: [
        { connection_id: 'via-ext', account_id: 'b', created_at: '1' },
        { connection_id: 'via-ext', account_id: 'c', created_at: '1' },
      ],
    });
    expect(await connectionForAccount(fake.db, 'a')).toBe('own');
    expect(await connectionForAccount(fake.db, 'b')).toBe('via-did');
    expect(await connectionForAccount(fake.db, 'c')).toBe('via-ext');
    expect(await connectionForAccount(fake.db, 'd')).toBeNull();
  });
});
