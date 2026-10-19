import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { VaultCryptoError, decrypt, encrypt, vaultAad } from './crypto';
import { loadVaultKeys } from './keys';

const K1 = randomBytes(32);
const K2 = randomBytes(32);
const BLIND = randomBytes(32);
const b64 = (b: Buffer) => b.toString('base64');
const b64url = (b: Buffer) => b.toString('base64url');

const goodEnv = (over: Record<string, string | undefined> = {}) => ({
  VAULT_KEYS: `k1:${b64(K1)},k2:${b64url(K2)}`,
  VAULT_CURRENT_KEY: 'k2',
  VAULT_BLIND_KEY: b64(BLIND),
  ...over,
});

/** Every textual form a key could leak in. */
const SECRETS = [K1, K2, BLIND].flatMap((k) => [
  b64(k),
  b64url(k),
  k.toString('hex'),
  k.toString('latin1'),
]);
const expectNoSecret = (text: string) => {
  for (const s of SECRETS) expect(text).not.toContain(s);
};

describe('loadVaultKeys', () => {
  it('loads keys in order, the current id and the blind key; both ids resolve (rotation)', () => {
    const r = loadVaultKeys(goodEnv());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keyIds).toEqual(['k1', 'k2']);
    expect(r.keys.currentKeyId()).toBe('k2');
    expect(r.keys.getKey('k1').equals(K1)).toBe(true);
    expect(r.keys.getKey('k2').equals(K2)).toBe(true);
    expect(r.blindKey.equals(BLIND)).toBe(true);

    // A payload written under the old key still decrypts after k2 became current.
    const aad = vaultAad('acc1', 'EID', 'a'.repeat(64));
    const old = loadVaultKeys(goodEnv({ VAULT_CURRENT_KEY: 'k1' }));
    if (!old.ok) throw new Error('expected ok');
    const p = encrypt('784199012345671', old.keys, aad);
    expect(p.keyId).toBe('k1');
    expect(decrypt(p, r.keys, aad)).toBe('784199012345671');
    expect(encrypt('784199012345671', r.keys, aad).keyId).toBe('k2');
  });

  it('getKey returns a copy, and an unknown id throws VaultCryptoError with no key material', () => {
    const r = loadVaultKeys(goodEnv());
    if (!r.ok) throw new Error('expected ok');
    r.keys.getKey('k1').fill(0);
    expect(r.keys.getKey('k1').equals(K1)).toBe(true);
    let err: unknown;
    try {
      r.keys.getKey('k3');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultCryptoError);
    const e = err as Error;
    expectNoSecret([String(e), e.message, e.stack ?? ''].join('\n'));
  });

  it('accepts unpadded and whitespace-padded entries and a longer blind key', () => {
    const r = loadVaultKeys({
      VAULT_KEYS: ` a_1:${b64(K1).replace(/=+$/, '')} , B-2:${b64url(K2)} `,
      VAULT_CURRENT_KEY: ' a_1 ',
      VAULT_BLIND_KEY: b64(randomBytes(64)),
    });
    expect(r.ok && r.keyIds).toEqual(['a_1', 'B-2']);
  });

  it('reads process.env at call time by default', () => {
    const saved = { ...process.env };
    try {
      delete process.env.VAULT_KEYS;
      delete process.env.VAULT_CURRENT_KEY;
      delete process.env.VAULT_BLIND_KEY;
      expect(loadVaultKeys()).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
      Object.assign(process.env, goodEnv());
      expect(loadVaultKeys().ok).toBe(true);
    } finally {
      for (const k of ['VAULT_KEYS', 'VAULT_CURRENT_KEY', 'VAULT_BLIND_KEY']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it.each([
    ['all unset', {}, 'NOT_CONFIGURED'],
    [
      'all blank',
      { VAULT_KEYS: '', VAULT_CURRENT_KEY: ' ', VAULT_BLIND_KEY: '' },
      'NOT_CONFIGURED',
    ],
  ] as const)('%s -> %s', (_name, env, reason) => {
    expect(loadVaultKeys(env)).toEqual({ ok: false, reason });
  });

  const short = randomBytes(31);
  it.each([
    ['VAULT_KEYS missing', { VAULT_KEYS: undefined }],
    ['an entry without a colon', { VAULT_KEYS: b64(K1) }],
    ['an empty entry', { VAULT_KEYS: `k1:${b64(K1)},` }],
    ['an empty id', { VAULT_KEYS: `:${b64(K1)}` }],
    ['an id over 32 chars', { VAULT_KEYS: `${'k'.repeat(33)}:${b64(K1)}` }],
    ['an id with a dot', { VAULT_KEYS: `k.1:${b64(K1)}` }],
    ['a duplicate id', { VAULT_KEYS: `k1:${b64(K1)},k1:${b64(K2)}` }],
    ['a 31-byte key', { VAULT_KEYS: `k1:${b64(short)}` }],
    ['a 33-byte key', { VAULT_KEYS: `k1:${b64(randomBytes(33))}` }],
    ['a 16-byte key', { VAULT_KEYS: `k1:${b64(randomBytes(16))}` }],
    ['not base64', { VAULT_KEYS: `k1:${b64(K1).slice(0, -2)}!!` }],
    ['mixed base64 alphabets', { VAULT_KEYS: `k1:${'+_'.repeat(21)}A=` }],
    ['a hex key', { VAULT_KEYS: `k1:${K1.toString('hex')}` }],
  ])('%s -> INVALID_KEYS', (_name, over) => {
    const r = loadVaultKeys(goodEnv(over));
    expect(r).toEqual({ ok: false, reason: 'INVALID_KEYS' });
    expectNoSecret(JSON.stringify(r));
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['not listed', 'k3'],
    ['a listed id in another case', 'K1'],
  ])('VAULT_CURRENT_KEY %s -> INVALID_CURRENT_KEY', (_name, current) => {
    const r = loadVaultKeys(goodEnv({ VAULT_CURRENT_KEY: current }));
    expect(r).toEqual({ ok: false, reason: 'INVALID_CURRENT_KEY' });
    expectNoSecret(JSON.stringify(r));
  });

  it.each([
    ['unset', undefined],
    ['16 bytes', b64(randomBytes(16))],
    ['31 bytes', b64(randomBytes(31))],
    ['not base64', '%%%%'],
    ['equal to an encryption key', b64(K1)],
    ['equal to an encryption key, url-safe', b64url(K2)],
  ])('VAULT_BLIND_KEY %s -> INVALID_BLIND_KEY', (_name, blind) => {
    const r = loadVaultKeys(goodEnv({ VAULT_BLIND_KEY: blind }));
    expect(r).toEqual({ ok: false, reason: 'INVALID_BLIND_KEY' });
    expectNoSecret(JSON.stringify(r));
  });
});
