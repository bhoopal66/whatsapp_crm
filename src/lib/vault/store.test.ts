// Ported from wacrm module 019c (vault), reference package 2026-10-18 (test/019c/vault.store.test.ts). The reference
// ran against a real Postgres; wacrm's vitest has none, so the store runs here on a fake supabase-js client whose
// `rpc` answers from a per-function script and records every call. The SQL side (roles, audit, rate limit, CONFLICT)
// is migration 121's and supabase/ci/verify-vault.sql's; this file pins what the store sends and how it reads answers.
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  VaultCryptoError,
  VaultInputError,
  blindIndex,
  decrypt,
  normalise,
  vaultAad,
  type EncryptedPayload,
  type KeyProvider,
  type VaultKind,
} from './crypto';
import {
  REWRAP_PAGE,
  VaultPutDeniedError,
  VaultPutFailedError,
  VaultRewrapFailedError,
  VaultStore,
  VaultStoreError,
  fromBytea,
  vaultAuditList,
  vaultOverview,
} from './store';
import { tokenizeSensitive } from './tokenize';

type Args = Record<string, unknown>;
type Answer = { data?: unknown; error?: { message: string; code?: string } };
type Script = Answer | Error | ((args: Args) => Answer);

/** A supabase-js stand-in: `rpc(fn, args)` answers from `script[fn]` (a queue, or one answer reused) and logs calls. */
class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  constructor(readonly script: Record<string, Script | Script[]> = {}) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const s = this.script[fn];
    const next = Array.isArray(s) ? s.shift() : s;
    if (next === undefined) throw new Error(`unscripted rpc ${fn}`);
    if (next instanceof Error) throw next;
    const a = typeof next === 'function' ? next(args) : next;
    return { data: a.data ?? null, error: a.error ?? null };
  }
  of(fn: string): Args[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const KEYS = new Map([
  ['k1', randomBytes(32)],
  ['k2', randomBytes(32)],
]);
function provider(current: string): KeyProvider {
  return {
    currentKeyId: () => current,
    getKey: (id) => {
      const k = KEYS.get(id);
      if (!k) throw new Error('unknown key');
      return k;
    },
  };
}
const BLIND = randomBytes(32);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const SUBJECT = {
  type: 'contact',
  id: '44444444-4444-4444-8444-444444444444',
} as const;
const EID = '784-1990-7654321-2';
const EID_NORM = '784199076543212';
const IBAN = 'AE07 0331 2345 6789 0123 456';
const ALPHA = 'ghjkmnpqrstvwxyz';
const newToken = () =>
  'vlt_' + Array.from(randomBytes(26), (b) => ALPHA[b % ALPHA.length]).join('');

/** The put arguments' payload, decoded from the hex bytea the store sent. */
function sentPayload(a: Args, keyField = 'p_key_id'): EncryptedPayload {
  return {
    ciphertext: fromBytea(a.p_ciphertext),
    iv: fromBytea(a.p_iv),
    tag: fromBytea(a.p_auth_tag),
    keyId: String(a[keyField]),
  };
}

/** A vault_reveal / vault_rewrap_candidates row as PostgREST returns it (bytea as '\\x' hex text). */
interface StoredRow {
  status: string;
  token: string;
  kind: string;
  ciphertext: unknown;
  iv: unknown;
  auth_tag: unknown;
  key_id: unknown;
  blind_index: unknown;
  [k: string]: unknown;
}

/** Puts `value` through a store on a fake DB and returns the vault_reveal row PostgREST would hand back for it. */
async function storedRow(
  account: string,
  kind: VaultKind,
  value: string,
  keyId = 'k1'
): Promise<StoredRow> {
  const token = newToken();
  const db = new FakeDb({
    vault_put: { data: [{ status: 'OK', token, deduped: false }] },
  });
  await new VaultStore(db.client, provider(keyId), BLIND).put(
    account,
    kind,
    value,
    SUBJECT,
    ACTOR
  );
  const a = db.of('vault_put')[0]!;
  return {
    status: 'OK',
    token,
    kind,
    ciphertext: a.p_ciphertext,
    iv: a.p_iv,
    auth_tag: a.p_auth_tag,
    key_id: a.p_key_id,
    blind_index: a.p_blind_index,
  };
}

describe('VaultStore.put', () => {
  it('sends hex bytea of an AES-GCM payload bound to account + kind + blind index, and no plaintext', async () => {
    const db = new FakeDb({
      vault_put: { data: [{ status: 'OK', token: 'vlt_t', deduped: false }] },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    expect(await store.put(ACCOUNT, 'EID', EID, SUBJECT, ACTOR)).toEqual({
      token: 'vlt_t',
      deduped: false,
    });
    const a = db.of('vault_put')[0]!;
    const index = blindIndex(ACCOUNT, 'EID', EID_NORM, BLIND);
    expect(a).toMatchObject({
      p_actor: ACTOR,
      p_account: ACCOUNT,
      p_kind: 'EID',
      p_key_id: 'k1',
      p_blind_index: index,
      p_subject_type: 'contact',
      p_subject_id: SUBJECT.id,
    });
    for (const f of ['p_ciphertext', 'p_iv', 'p_auth_tag'])
      expect(a[f]).toMatch(/^\\x([0-9a-f]{2})+$/);
    const payload = sentPayload(a);
    expect(payload.iv).toHaveLength(12);
    expect(payload.tag).toHaveLength(16);
    expect(
      decrypt(payload, provider('k1'), vaultAad(ACCOUNT, 'EID', index))
    ).toBe(EID_NORM);
    for (const aad of [
      vaultAad(OTHER, 'EID', index),
      vaultAad(ACCOUNT, 'ACCOUNT', index),
      vaultAad(
        ACCOUNT,
        'EID',
        blindIndex(ACCOUNT, 'EID', '784199076543213', BLIND)
      ),
    ])
      expect(() => decrypt(payload, provider('k1'), aad)).toThrow(
        VaultCryptoError
      );
    const sent = JSON.stringify(a);
    expect(sent).not.toContain(EID_NORM);
    expect(sent).not.toContain('7654321');
  });

  it('a dedupe returns the live token', async () => {
    const db = new FakeDb({
      vault_put: { data: [{ status: 'OK', token: 'vlt_live', deduped: true }] },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    expect(await store.put(ACCOUNT, 'IBAN', IBAN, SUBJECT, ACTOR)).toEqual({
      token: 'vlt_live',
      deduped: true,
    });
  });

  it('an invalid value is refused before any database call, and the error names no value', async () => {
    const db = new FakeDb();
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    const err = await store
      .put(ACCOUNT, 'EID', '784-1990-765', SUBJECT, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultInputError);
    expect(String(err)).not.toContain('765');
    expect(db.calls).toHaveLength(0);
  });

  it('DENIED throws VaultPutDeniedError with a fixed message carrying no value', async () => {
    const db = new FakeDb({
      vault_put: { data: [{ status: 'DENIED', token: null, deduped: null }] },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    const err = await store
      .put(ACCOUNT, 'EID', EID, SUBJECT, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultPutDeniedError);
    const e = err as VaultPutDeniedError;
    expect(e.name).toBe('VaultPutDeniedError');
    expect(e.message).toBe('vault: put denied');
    expect(e.cause).toBeUndefined();
    for (const text of [e.message, String(e.stack), JSON.stringify(e)]) {
      expect(text).not.toContain(EID_NORM);
      expect(text).not.toContain('7654321');
    }
  });

  it.each([
    [
      'a database error',
      {
        error: {
          message: `new row violates check constraint, failing row (${EID_NORM}, \\xdeadbeef)`,
          code: '23514',
        },
      },
    ],
    ['a thrown transport error', new Error(`fetch failed for ${EID_NORM}`)],
    ['an empty answer', { data: [] }],
  ] as const)(
    '%s throws VaultPutFailedError: fixed message, no cause / code / DB text',
    async (_, answer) => {
      const db = new FakeDb({ vault_put: answer as Script });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      const err = await store
        .put(ACCOUNT, 'EID', EID, SUBJECT, ACTOR)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultPutFailedError);
      const e = err as VaultPutFailedError & { code?: unknown };
      expect(e.message).toBe('vault: put failed');
      expect(e.cause).toBeUndefined();
      expect(e.code).toBeUndefined();
      expect(Object.keys(e)).toEqual(['name']);
      for (const text of [String(e.stack), JSON.stringify(e)]) {
        expect(text).not.toContain(EID_NORM);
        expect(text).not.toContain('deadbeef');
        expect(text).not.toContain('check constraint');
      }
    }
  );
});

describe('VaultStore.reveal', () => {
  it('OK returns the normalised value and sends the reveal arguments', async () => {
    const row = await storedRow(ACCOUNT, 'IBAN', IBAN);
    const db = new FakeDb({ vault_reveal: { data: [row] } });
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    expect(await store.reveal(ACTOR, ACCOUNT, row.token, 'KYC check')).toEqual({
      ok: true,
      kind: 'IBAN',
      value: normalise('IBAN', IBAN),
    });
    expect(db.calls).toEqual([
      {
        fn: 'vault_reveal',
        args: {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_token: row.token,
          p_reason: 'KYC check',
        },
      },
    ]);
  });

  it.each([
    [
      'a payload from another account',
      async () => storedRow(OTHER, 'EID', EID),
    ],
    [
      'a payload under another kind (row kind relabelled)',
      async () => ({
        ...(await storedRow(ACCOUNT, 'EID', EID)),
        kind: 'ACCOUNT',
      }),
    ],
    [
      "another item's payload on this row (swapped blind index)",
      async () => ({
        ...(await storedRow(ACCOUNT, 'EID', EID)),
        blind_index: (await storedRow(ACCOUNT, 'EID', '784-1990-7654321-3'))
          .blind_index,
      }),
    ],
    [
      'an unknown key id',
      async () => ({ ...(await storedRow(ACCOUNT, 'EID', EID)), key_id: 'k9' }),
    ],
    [
      'a tampered ciphertext',
      async () => {
        const r = await storedRow(ACCOUNT, 'EID', EID);
        const c = fromBytea(r.ciphertext);
        c[0] ^= 1;
        return { ...r, ciphertext: '\\x' + c.toString('hex') };
      },
    ],
  ])(
    '%s is DECRYPT_FAILED and reported to vault_reveal_failed',
    async (_, make) => {
      const row = await make();
      const db = new FakeDb({
        vault_reveal: { data: [row] },
        vault_reveal_failed: { data: 'OK' },
      });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      const r = await store.reveal(ACTOR, ACCOUNT, row.token, 'why');
      expect(r).toEqual({ ok: false, status: 'DECRYPT_FAILED' });
      expect(db.of('vault_reveal_failed')).toEqual([
        { p_actor: ACTOR, p_account: ACCOUNT, p_token: row.token },
      ]);
    }
  );

  it.each([
    ['hex without the \\x prefix', (h: string) => h.slice(2)],
    ['a non-hex digit', (h: string) => h.slice(0, -1) + 'z'],
    ['an odd number of digits', (h: string) => h.slice(0, -1)],
    [
      'base64 text',
      (h: string) => Buffer.from(h.slice(2), 'hex').toString('base64'),
    ],
    ['null', () => null],
    ['a number', () => 42],
  ])(
    'a malformed bytea (%s) is DECRYPT_FAILED, never an exception',
    async (_, mangle) => {
      for (const field of ['ciphertext', 'iv', 'auth_tag']) {
        const row = await storedRow(ACCOUNT, 'EID', EID);
        const db = new FakeDb({
          vault_reveal: {
            data: [{ ...row, [field]: mangle(String(row[field])) }],
          },
          vault_reveal_failed: { data: 'OK' },
        });
        const store = new VaultStore(db.client, provider('k1'), BLIND);
        await expect(
          store.reveal(ACTOR, ACCOUNT, row.token, 'why')
        ).resolves.toEqual({
          ok: false,
          status: 'DECRYPT_FAILED',
        });
        expect(db.of('vault_reveal_failed')).toHaveLength(1);
      }
    }
  );

  it.each([
    ['an error answer', { error: { message: 'boom', code: 'XX000' } }],
    ['a thrown error', new Error('network down')],
  ])(
    'a failing vault_reveal_failed (%s) is ignored: still DECRYPT_FAILED',
    async (_, answer) => {
      const row = { ...(await storedRow(ACCOUNT, 'EID', EID)), key_id: 'k9' };
      const db = new FakeDb({
        vault_reveal: { data: [row] },
        vault_reveal_failed: answer as Script,
      });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      await expect(
        store.reveal(ACTOR, ACCOUNT, row.token, 'why')
      ).resolves.toEqual({
        ok: false,
        status: 'DECRYPT_FAILED',
      });
    }
  );

  it.each(['DENIED', 'NOT_FOUND', 'RATE_LIMITED'] as const)(
    '%s passes through without a decrypt or a failure report',
    async (status) => {
      const db = new FakeDb({
        vault_reveal: {
          data: [
            {
              status,
              kind: null,
              ciphertext: null,
              iv: null,
              auth_tag: null,
              key_id: null,
              blind_index: null,
            },
          ],
        },
      });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      expect(await store.reveal(ACTOR, ACCOUNT, newToken(), 'why')).toEqual({
        ok: false,
        status,
      });
      expect(db.calls).toHaveLength(1);
    }
  );

  it('a database error throws VaultStoreError with the SQLSTATE only', async () => {
    const db = new FakeDb({
      vault_reveal: {
        error: {
          message: 'invalid input syntax for type uuid: "secret"',
          code: '22P02',
        },
      },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    const err = await store
      .reveal('secret', ACCOUNT, newToken(), 'why')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultStoreError);
    expect((err as VaultStoreError).code).toBe('22P02');
    expect((err as Error).message).toBe('vault: vault_reveal failed');
  });
});

describe('VaultStore delete, roles and audit', () => {
  it.each(['OK', 'DENIED', 'NOT_FOUND'] as const)(
    'delete passes %s through',
    async (s) => {
      const db = new FakeDb({ vault_delete: { data: s } });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      expect(await store.delete(ACTOR, ACCOUNT, 'vlt_x', 'gone')).toBe(s);
      expect(db.of('vault_delete')).toEqual([
        {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_token: 'vlt_x',
          p_reason: 'gone',
        },
      ]);
    }
  );

  it.each(['OK', 'NOOP', 'DENIED'] as const)(
    'bootstrap / grant / revoke pass %s through',
    async (s) => {
      const user = '55555555-5555-4555-8555-555555555555';
      const db = new FakeDb({
        vault_role_bootstrap: { data: s },
        vault_role_grant: { data: s },
        vault_role_revoke: { data: s },
      });
      const store = new VaultStore(db.client, provider('k1'), BLIND);
      expect(await store.bootstrap(ACTOR, ACCOUNT, user)).toBe(s);
      expect(await store.grant(ACTOR, ACCOUNT, user, 'admin')).toBe(s);
      expect(await store.revoke(ACTOR, ACCOUNT, user, 'super_admin')).toBe(s);
      expect(db.calls).toEqual([
        {
          fn: 'vault_role_bootstrap',
          args: { p_actor: ACTOR, p_account: ACCOUNT, p_user: user },
        },
        {
          fn: 'vault_role_grant',
          args: {
            p_actor: ACTOR,
            p_account: ACCOUNT,
            p_user: user,
            p_role: 'admin',
          },
        },
        {
          fn: 'vault_role_revoke',
          args: {
            p_actor: ACTOR,
            p_account: ACCOUNT,
            p_user: user,
            p_role: 'super_admin',
          },
        },
      ]);
    }
  );

  it('an unexpected status is a VaultStoreError, not passed through', async () => {
    const db = new FakeDb({ vault_role_grant: { data: 'MAYBE' } });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    await expect(store.grant(ACTOR, ACCOUNT, ACTOR, 'admin')).rejects.toThrow(
      VaultStoreError
    );
  });

  it('auditList maps rows and sends the limit (default 100)', async () => {
    const row = {
      id: 7,
      at: '2026-10-19T08:00:00.123456+00:00',
      action: 'reveal',
      outcome: 'OK',
      actor: ACTOR,
      account_id: ACCOUNT,
      token: 'vlt_x',
      kind: 'EID',
      subject_type: 'contact',
      subject_id: SUBJECT.id,
      reason: 'KYC',
      detail: { role: 'admin' },
    };
    const db = new FakeDb({
      vault_audit_list: [{ data: [row] }, { data: [] }],
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    expect(await store.auditList(ACTOR, ACCOUNT)).toEqual([
      {
        id: '7',
        at: new Date('2026-10-19T08:00:00.123Z'),
        action: 'reveal',
        outcome: 'OK',
        actor: ACTOR,
        accountId: ACCOUNT,
        token: 'vlt_x',
        kind: 'EID',
        subjectType: 'contact',
        subjectId: SUBJECT.id,
        reason: 'KYC',
        detail: { role: 'admin' },
      },
    ]);
    expect(await store.auditList(ACTOR, ACCOUNT, 20)).toEqual([]);
    expect(db.of('vault_audit_list').map((a) => a.p_limit)).toEqual([100, 20]);
  });
});

describe('VaultStore.rewrap', () => {
  /** A candidate row for a value written under k1, at a fixed position in (created_at, id) order. */
  async function candidate(n: number, value = EID) {
    const r = await storedRow(ACCOUNT, 'EID', value, 'k1');
    return {
      ...r,
      created_at: `2026-10-19T08:00:00.${String(n).padStart(6, '0')}+00:00`,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    };
  }
  const filler = (n: number) => ({
    status: 'OK',
    token: newToken(),
    kind: 'EID',
    ciphertext: '\\x00',
    iv: '\\x00',
    auth_tag: '\\x00',
    key_id: 'k1',
    blind_index: 'f',
    created_at: `2026-10-19T07:00:00.${String(n).padStart(6, '0')}+00:00`,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  });

  it('pages with the keyset cursor (second page short), rewraps under the current key, lists unseen tokens NOT_CANDIDATE', async () => {
    const a = await candidate(1);
    const b = await candidate(2, '784-1990-7654321-3');
    const page1 = [
      ...Array.from({ length: REWRAP_PAGE - 1 }, (_, i) => filler(i)),
      a,
    ];
    const page2 = [b];
    const db = new FakeDb({
      vault_rewrap_candidates: [{ data: page1 }, { data: page2 }],
      vault_rewrap: { data: 'OK' },
    });
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    const missing = newToken();
    const r = await store.rewrap(
      ACTOR,
      ACCOUNT,
      [a.token, b.token, missing],
      'k1'
    );
    expect(r).toEqual({
      status: 'OK',
      items: [
        { token: a.token, status: 'OK' },
        { token: b.token, status: 'OK' },
        { token: missing, status: 'NOT_CANDIDATE' },
      ],
    });
    expect(db.of('vault_rewrap_candidates')).toEqual([
      {
        p_actor: ACTOR,
        p_account: ACCOUNT,
        p_old_key_id: 'k1',
        p_limit: REWRAP_PAGE,
        p_after_created_at: null,
        p_after_id: null,
      },
      {
        p_actor: ACTOR,
        p_account: ACCOUNT,
        p_old_key_id: 'k1',
        p_limit: REWRAP_PAGE,
        p_after_created_at: a.created_at,
        p_after_id: a.id,
      },
    ]);
    const swaps = db.of('vault_rewrap');
    expect(swaps.map((s) => s.p_token)).toEqual([a.token, b.token]);
    for (const [s, row, plain] of [
      [swaps[0]!, a, EID_NORM],
      [swaps[1]!, b, '784199076543213'],
    ] as const) {
      expect(s).toMatchObject({
        p_actor: ACTOR,
        p_account: ACCOUNT,
        p_expected_key_id: 'k1',
        p_new_key_id: 'k2',
      });
      const aad = vaultAad(ACCOUNT, 'EID', String(row.blind_index));
      expect(decrypt(sentPayload(s, 'p_new_key_id'), provider('k2'), aad)).toBe(
        plain
      );
    }
  });

  it('a full page that holds every listed token is the last one read', async () => {
    const a = await candidate(1);
    const page = [
      ...Array.from({ length: REWRAP_PAGE - 1 }, (_, i) => filler(i)),
      a,
    ];
    const db = new FakeDb({
      vault_rewrap_candidates: [{ data: page }],
      vault_rewrap: { data: 'OK' },
    });
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    expect((await store.rewrap(ACTOR, ACCOUNT, [a.token], 'k1')).items).toEqual(
      [{ token: a.token, status: 'OK' }]
    );
    expect(db.of('vault_rewrap_candidates')).toHaveLength(1);
  });

  it('CONFLICT is reported and not retried; NOT_FOUND / DENIED pass through', async () => {
    const [a, b, c] = [
      await candidate(1),
      await candidate(2),
      await candidate(3),
    ];
    const db = new FakeDb({
      vault_rewrap_candidates: [{ data: [a, b, c] }],
      vault_rewrap: [
        { data: 'CONFLICT' },
        { data: 'NOT_FOUND' },
        { data: 'DENIED' },
      ],
    });
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    const r = await store.rewrap(
      ACTOR,
      ACCOUNT,
      [a.token, b.token, c.token],
      'k1'
    );
    expect(r.items.map((i) => i.status)).toEqual([
      'CONFLICT',
      'NOT_FOUND',
      'DENIED',
    ]);
    expect(db.of('vault_rewrap').map((s) => s.p_token)).toEqual([
      a.token,
      b.token,
      c.token,
    ]);
  });

  it.each([
    [
      'an error answer',
      { error: { message: `failing row ${EID_NORM}`, code: '23514' } },
    ],
    ['a thrown error', new Error(`failing row ${EID_NORM}`)],
    ['an unknown status', { data: 'WAT' }],
  ])(
    '%s from vault_rewrap is that item ERROR (token and status only); the batch goes on',
    async (_, answer) => {
      const [a, b] = [await candidate(1), await candidate(2)];
      const db = new FakeDb({
        vault_rewrap_candidates: [{ data: [a, b] }],
        vault_rewrap: [answer as Script, { data: 'OK' }],
      });
      const store = new VaultStore(db.client, provider('k2'), BLIND);
      const r = await store.rewrap(ACTOR, ACCOUNT, [a.token, b.token], 'k1');
      expect(r).toEqual({
        status: 'OK',
        items: [
          { token: a.token, status: 'ERROR' },
          { token: b.token, status: 'OK' },
        ],
      });
    }
  );

  it.each([
    ['answers', { data: 'OK' }],
    ['fails', { error: { message: 'boom', code: 'XX000' } }],
    ['throws', new Error('network down')],
  ])(
    'a candidate that does not decrypt is DECRYPT_FAILED, reported best effort (the report %s), and the batch goes on',
    async (_, answer) => {
      const a = await candidate(1);
      const bad = {
        ...(await candidate(2)),
        auth_tag: '\\x' + '00'.repeat(16),
      };
      const malformed = { ...(await candidate(3)), iv: 'not-bytea' };
      const db = new FakeDb({
        vault_rewrap_candidates: [{ data: [bad, malformed, a] }],
        vault_rewrap_failed: [answer as Script, answer as Script],
        vault_rewrap: { data: 'OK' },
      });
      const store = new VaultStore(db.client, provider('k2'), BLIND);
      const r = await store.rewrap(
        ACTOR,
        ACCOUNT,
        [bad.token, malformed.token, a.token],
        'k1'
      );
      expect(r.items).toEqual([
        { token: bad.token, status: 'DECRYPT_FAILED' },
        { token: malformed.token, status: 'DECRYPT_FAILED' },
        { token: a.token, status: 'OK' },
      ]);
      expect(db.of('vault_rewrap_failed')).toEqual([
        {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_token: bad.token,
          p_key_id: 'k1',
        },
        {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_token: malformed.token,
          p_key_id: 'k1',
        },
      ]);
      expect(db.of('vault_rewrap').map((s) => s.p_token)).toEqual([a.token]);
    }
  );

  it.each([
    [
      'an error answer',
      { error: { message: `bad row ${EID_NORM}`, code: '22023' } },
    ],
    ['a thrown error', new Error(`bad row ${EID_NORM}`)],
  ])(
    '%s from vault_rewrap_candidates throws VaultRewrapFailedError: fixed message, no cause / code',
    async (_, answer) => {
      const db = new FakeDb({ vault_rewrap_candidates: answer as Script });
      const store = new VaultStore(db.client, provider('k2'), BLIND);
      const err = await store
        .rewrap(ACTOR, ACCOUNT, ['vlt_x'], 'k1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultRewrapFailedError);
      const e = err as VaultRewrapFailedError & { code?: unknown };
      expect(e.message).toBe('vault: rewrap failed');
      expect(e.cause).toBeUndefined();
      expect(e.code).toBeUndefined();
      expect(String(e.stack)).not.toContain(EID_NORM);
    }
  );

  it('a refused candidates read (one DENIED row) is DENIED with no items', async () => {
    const db = new FakeDb({
      vault_rewrap_candidates: { data: [{ status: 'DENIED', token: null }] },
    });
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    expect(await store.rewrap(ACTOR, ACCOUNT, ['vlt_x'], 'k1')).toEqual({
      status: 'DENIED',
      items: [],
    });
  });

  it('refuses the current key as the old one before any call', async () => {
    const db = new FakeDb();
    const store = new VaultStore(db.client, provider('k2'), BLIND);
    await expect(store.rewrap(ACTOR, ACCOUNT, ['vlt_x'], 'k2')).rejects.toThrow(
      RangeError
    );
    expect(db.calls).toHaveLength(0);
  });
});

describe('tokenizeSensitive over a VaultStore', () => {
  it('vaults each value through vault_put and puts the tokens in the text', async () => {
    const tokens = new Map<string, string>();
    const db = new FakeDb({
      vault_put: (a) => {
        const key = `${a.p_kind}|${a.p_blind_index}`;
        const deduped = tokens.has(key);
        if (!deduped) tokens.set(key, newToken());
        return { data: [{ status: 'OK', token: tokens.get(key), deduped }] };
      },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    const ctx = { workspace: ACCOUNT, subject: SUBJECT, actor: ACTOR };
    const r = await tokenizeSensitive(
      `EID ${EID}, IBAN ${IBAN}, again ${EID_NORM}`,
      ctx,
      store
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vaulted).toBe(3);
    const eid = tokens.get(
      `EID|${blindIndex(ACCOUNT, 'EID', EID_NORM, BLIND)}`
    )!;
    const iban = [...tokens.entries()].find(([k]) => k.startsWith('IBAN|'))![1];
    expect(r.text).toBe(
      `EID [EID:${eid}], IBAN [IBAN:${iban}], again [EID:${eid}]`
    );
    const puts = db.of('vault_put');
    expect(puts).toHaveLength(3);
    const ibanPut = puts.find((p) => p.p_kind === 'IBAN')!;
    expect(
      decrypt(
        sentPayload(ibanPut),
        provider('k1'),
        vaultAad(ACCOUNT, 'IBAN', String(ibanPut.p_blind_index))
      )
    ).toBe('AE070331234567890123456');
  });

  it('a DENIED put fails the whole text with a reason that names the error, not the value', async () => {
    const db = new FakeDb({
      vault_put: { data: [{ status: 'DENIED', token: null, deduped: null }] },
    });
    const store = new VaultStore(db.client, provider('k1'), BLIND);
    const r = await tokenizeSensitive(
      `EID ${EID}`,
      { workspace: ACCOUNT, subject: SUBJECT, actor: ACTOR },
      store
    );
    expect(r).toEqual({
      ok: false,
      reason: 'vault put failed: EID: VaultPutDeniedError',
    });
  });
});

describe('vaultOverview / vaultAuditList (no keys)', () => {
  const GRANTER = '55555555-5555-4555-8555-555555555555';

  it('vaultOverview sends actor and account and maps the answer', async () => {
    const db = new FakeDb({
      vault_overview: {
        data: {
          bootstrap_available: false,
          my_role: 'super_admin',
          roles: [
            {
              user_id: ACTOR,
              role: 'super_admin',
              granted_by: GRANTER,
              granted_at: '2026-10-19T08:00:00.5+00:00',
              counts: true,
            },
            {
              user_id: OTHER,
              role: 'admin',
              granted_by: null,
              granted_at: 'not a time',
              counts: false,
            },
          ],
        },
      },
    });
    expect(await vaultOverview(db.client, ACTOR, ACCOUNT)).toEqual({
      bootstrapAvailable: false,
      myRole: 'super_admin',
      roles: [
        {
          userId: ACTOR,
          role: 'super_admin',
          grantedBy: GRANTER,
          grantedAt: new Date('2026-10-19T08:00:00.500Z'),
          counts: true,
        },
        {
          userId: OTHER,
          role: 'admin',
          grantedBy: null,
          grantedAt: null,
          counts: false,
        },
      ],
    });
    expect(db.of('vault_overview')).toEqual([
      { p_actor: ACTOR, p_account: ACCOUNT },
    ]);
  });

  it('vaultOverview fails closed on an unexpected answer', async () => {
    const db = new FakeDb({
      vault_overview: {
        data: {
          bootstrap_available: 'yes',
          my_role: 'owner',
          roles: [
            null,
            { user_id: ACTOR, role: 'owner', counts: true },
            { user_id: 7, role: 'admin', counts: true },
            { user_id: OTHER, role: 'admin', counts: 'true' },
          ],
        },
      },
    });
    expect(await vaultOverview(db.client, ACTOR, ACCOUNT)).toEqual({
      bootstrapAvailable: false,
      myRole: null,
      roles: [
        {
          userId: OTHER,
          role: 'admin',
          grantedBy: null,
          grantedAt: null,
          counts: false,
        },
      ],
    });
    const noRoles = new FakeDb({
      vault_overview: { data: { bootstrap_available: true, my_role: null } },
    });
    expect(await vaultOverview(noRoles.client, ACTOR, ACCOUNT)).toEqual({
      bootstrapAvailable: true,
      myRole: null,
      roles: [],
    });
  });

  it('vaultOverview throws a VaultStoreError with the SQLSTATE only', async () => {
    const failed = new FakeDb({
      vault_overview: { error: { message: 'secret detail', code: '22023' } },
    });
    const err = await vaultOverview(failed.client, ACTOR, ACCOUNT).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(VaultStoreError);
    expect((err as VaultStoreError).code).toBe('22023');
    expect((err as Error).message).toBe('vault: vault_overview failed');
    for (const data of [null, [], 'OK']) {
      const db = new FakeDb({ vault_overview: { data } });
      await expect(vaultOverview(db.client, ACTOR, ACCOUNT)).rejects.toThrow(
        VaultStoreError
      );
    }
  });

  it('vaultAuditList reads the audit on a bare client', async () => {
    const db = new FakeDb({
      vault_audit_list: [
        {
          data: [
            {
              id: 9,
              at: '2026-10-19T08:00:00Z',
              action: 'role_grant',
              outcome: 'OK',
              actor: ACTOR,
              account_id: ACCOUNT,
              token: null,
              kind: null,
              subject_type: null,
              subject_id: null,
              reason: null,
              detail: null,
            },
          ],
        },
        { error: { message: 'x', code: '42501' } },
      ],
    });
    expect(await vaultAuditList(db.client, ACTOR, ACCOUNT, 5)).toEqual([
      {
        id: '9',
        at: new Date('2026-10-19T08:00:00Z'),
        action: 'role_grant',
        outcome: 'OK',
        actor: ACTOR,
        accountId: ACCOUNT,
        token: null,
        kind: null,
        subjectType: null,
        subjectId: null,
        reason: null,
        detail: {},
      },
    ]);
    await expect(vaultAuditList(db.client, ACTOR, ACCOUNT)).rejects.toThrow(
      VaultStoreError
    );
    expect(db.of('vault_audit_list').map((a) => a.p_limit)).toEqual([5, 100]);
  });
});
