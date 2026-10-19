// Ported from wacrm module 019c (vault), reference package 2026-10-18 (test/019c/vault.crypto.test.ts).
// A `workspace` here means the wacrm account id.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  VaultCryptoError,
  VaultInputError,
  blindIndex,
  decrypt,
  encrypt,
  normalise,
  vaultAad,
  type EncryptedPayload,
  type KeyProvider,
  type VaultKind,
} from './crypto';

const keyring = (
  current: string,
  keys: Record<string, Buffer>
): KeyProvider => ({
  currentKeyId: () => current,
  getKey: (id) => {
    const k = keys[id];
    if (!k) throw new Error(`no key ${id}`);
    return k;
  },
});
const K1 = randomBytes(32);
const keys = keyring('k1', { k1: K1 });
const BI = 'a'.repeat(64);
const BI2 = 'b'.repeat(64);
const AAD = vaultAad('ws1', 'EID', BI);
const PLAIN = '784199012345671';
const flip = (b: Buffer, i = 0) => {
  const c = Buffer.from(b);
  c[i] = c[i]! ^ 0x01;
  return c;
};
/** Everything an error exposes as text. */
const errorText = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const err = e as Error;
    return [
      String(err),
      err.message,
      err.stack ?? '',
      JSON.stringify(err),
      String((err as { cause?: unknown }).cause ?? ''),
    ].join('\n');
  }
  throw new Error('expected a throw');
};

describe('019c crypto: AES-256-GCM', () => {
  it('round trip, payload shape and key id', () => {
    const p = encrypt(PLAIN, keys, AAD);
    expect(p.keyId).toBe('k1');
    expect([p.iv.length, p.tag.length, p.ciphertext.length]).toEqual([
      12,
      16,
      Buffer.byteLength(PLAIN),
    ]);
    expect(p.ciphertext.toString('utf8')).not.toContain(PLAIN);
    expect(decrypt(p, keys, AAD)).toBe(PLAIN);
    const unicode = 'N\u00e9e \u0645\u062d\u0645\u062f';
    expect(decrypt(encrypt(unicode, keys, AAD), keys, AAD)).toBe(unicode);
  });

  it('the same plaintext twice gives a different iv and a different ciphertext', () => {
    const a = encrypt(PLAIN, keys, AAD);
    const b = encrypt(PLAIN, keys, AAD);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('tampering with the ciphertext, iv, tag or aad each fails authentication', () => {
    const p = encrypt(PLAIN, keys, AAD);
    const cases: Array<[string, EncryptedPayload, Buffer]> = [
      ['ciphertext', { ...p, ciphertext: flip(p.ciphertext, 3) }, AAD],
      ['iv', { ...p, iv: flip(p.iv, 5) }, AAD],
      ['tag', { ...p, tag: flip(p.tag, 15) }, AAD],
      ['aad', p, Buffer.from(`ws1|EIE|${BI}`)],
    ];
    for (const [, payload, aad] of cases) {
      expect(() => decrypt(payload, keys, aad)).toThrow(VaultCryptoError);
      expect(() => decrypt(payload, keys, aad)).toThrow(
        'vault: decrypt failed'
      );
    }
    expect(decrypt(p, keys, AAD)).toBe(PLAIN);
  });

  it('a ciphertext cannot be moved across workspaces, kinds or items (aad binds workspace|kind|blind_index)', () => {
    const p = encrypt(PLAIN, keys, vaultAad('ws1', 'EID', BI));
    expect(decrypt(p, keys, vaultAad('ws1', 'EID', BI))).toBe(PLAIN);
    expect(() => decrypt(p, keys, vaultAad('ws2', 'EID', BI))).toThrow(
      VaultCryptoError
    );
    expect(() => decrypt(p, keys, vaultAad('ws1', 'PASSPORT', BI))).toThrow(
      VaultCryptoError
    );
    expect(() => decrypt(p, keys, vaultAad('ws1', 'EID', BI2))).toThrow(
      VaultCryptoError
    );
    expect(vaultAad('ws1', 'EID', BI).toString()).toBe(`ws1|EID|${BI}`);
  });

  it('a wrong key, an unknown key id and a key that is not 32 bytes fail', () => {
    const p = encrypt(PLAIN, keys, AAD);
    expect(() =>
      decrypt(p, keyring('k1', { k1: randomBytes(32) }), AAD)
    ).toThrow('vault: decrypt failed');
    expect(() => decrypt(p, keyring('k2', { k2: K1 }), AAD)).toThrow(
      VaultCryptoError
    );
    for (const n of [16, 31, 33, 64]) {
      const bad = keyring('k1', { k1: randomBytes(n) });
      expect(() => encrypt(PLAIN, bad, AAD)).toThrow('vault: invalid key');
      expect(() => decrypt(p, bad, AAD)).toThrow('vault: invalid key');
    }
    expect(() => encrypt('', keys, AAD)).toThrow(VaultCryptoError);
    expect(() => encrypt('x'.repeat(4097), keys, AAD)).toThrow(
      VaultCryptoError
    );
  });

  it('errors carry neither the plaintext nor the key', () => {
    const p = encrypt(PLAIN, keys, AAD);
    const texts = [
      errorText(() => decrypt({ ...p, tag: flip(p.tag) }, keys, AAD)),
      errorText(() => decrypt(p, keyring('k1', { k1: randomBytes(32) }), AAD)),
      errorText(() => decrypt({ ...p, iv: p.iv.subarray(0, 8) }, keys, AAD)),
      errorText(() => normalise('EID', '784-1990-1234567')),
      errorText(() => normalise('IBAN', 'AE08 0331 2345 6789 0123 456')),
    ];
    for (const t of texts) {
      for (const needle of [
        PLAIN,
        '7841990',
        K1.toString('hex'),
        K1.toString('base64'),
        '0331234567890123456',
      ])
        expect(t).not.toContain(needle);
    }
  });
});

describe('019c normalise', () => {
  const ok: Array<[VaultKind, string, string]> = [
    ['EID', '784-1990-1234567-1', PLAIN],
    ['EID', ' 784 1990 1234567 1 ', PLAIN],
    // Arabic-Indic digits, with a right-to-left mark inside.
    [
      'EID',
      '\u0667\u0668\u0664-\u0661\u0669\u0669\u0660-\u0661\u0662\u0663\u0664\u0665\u0666\u0667-\u200f\u0661',
      PLAIN,
    ],
    // Extended Arabic-Indic (Persian) digits.
    [
      'EID',
      '\u06f7\u06f8\u06f4\u06f1\u06f9\u06f9\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f1',
      PLAIN,
    ],
    ['IBAN', 'ae07 0331 2345 6789 0123 456', 'AE070331234567890123456'],
    ['IBAN', 'AE07-0331-2345-6789-0123-456', 'AE070331234567890123456'],
    ['IBAN', 'GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432'],
    ['PHONE', '0501234567', '971501234567'],
    ['PHONE', '050-123-4567', '971501234567'],
    ['PHONE', '+971 50 123 4567', '971501234567'],
    ['PHONE', '00971501234567', '971501234567'],
    ['PHONE', '+971 (0)50 123 4567', '971501234567'],
    ['PHONE', '971501234567', '971501234567'],
    [
      'PHONE',
      '\u0660\u0665\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667',
      '971501234567',
    ],
    ['PHONE', '04 123 4567', '97141234567'],
    ['PHONE', '+44 20 7946 0958', '442079460958'],
    ['PASSPORT', 'n1234567', 'N1234567'],
    ['PASSPORT', 'AB 12345', 'AB12345'],
    ['ACCOUNT', '0123 4567 89', '0123456789'],
    ['ACCOUNT', '1234-5678-9012-3456-78', '123456789012345678'],
    ['TRADE_LICENCE', 'cn-1234/5', 'CN-1234/5'],
    ['TRADE_LICENCE', ' 12 34 56 ', '123456'],
  ];
  it.each(ok)('%s %j -> %s', (kind, value, expected) => {
    expect(normalise(kind, value)).toBe(expected);
  });

  const bad: Array<[VaultKind, string]> = [
    ['EID', '784-1990-1234567'],
    ['EID', '7841990123456712'],
    ['EID', '784-1990-123456A-1'],
    ['IBAN', 'AE08 0331 2345 6789 0123 456'],
    ['IBAN', 'AE07 0331 2345 6789 0123 457'],
    ['IBAN', 'AE07'],
    ['IBAN', 'AE07 0331 2345 6789 0123 45\u00df'],
    ['PHONE', '12'],
    ['PHONE', '+0501234567'],
    ['PHONE', '050 123 abc'],
    ['PASSPORT', 'N123'],
    ['PASSPORT', 'N12345678X'],
    ['ACCOUNT', '12345'],
    ['ACCOUNT', '123456789012345678901'],
    ['ACCOUNT', '12345A78'],
    ['TRADE_LICENCE', '--//'],
    ['TRADE_LICENCE', 'CN#1234'],
  ];
  it.each(bad)('%s %j is refused', (kind, value) => {
    expect(() => normalise(kind, value)).toThrow(VaultInputError);
  });

  it('an ACCOUNT or PHONE that is a 13-19 digit Luhn-valid number (a card number) is refused', () => {
    for (const v of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '4222222222222',
      '6011000990139424',
    ]) {
      expect(() => normalise('ACCOUNT', v)).toThrow(VaultInputError);
    }
    for (const v of [
      '+4222222222222',
      '+4111 1111 1111 1111',
      '004222222222222',
    ])
      expect(() => normalise('PHONE', v)).toThrow(VaultInputError);
    expect(normalise('ACCOUNT', '4111111111111112')).toBe('4111111111111112');
    expect(normalise('ACCOUNT', '012345678901')).toBe('012345678901');
    expect(normalise('PHONE', '+971501234567')).toBe('971501234567');
  });

  it('CARD / CVV / OTP / PIN are not vault kinds', () => {
    for (const k of ['CARD', 'CVV', 'OTP', 'PIN'])
      expect(() => normalise(k as VaultKind, '4111111111111111')).toThrow(
        'vault: unsupported kind'
      );
  });
});

describe('019c blind index', () => {
  const bk = randomBytes(32);
  it('is stable, 64-char lowercase hex, keyed and kind-separated', () => {
    const a = blindIndex('W1', 'EID', PLAIN, bk);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(blindIndex('W1', 'EID', PLAIN, Buffer.from(bk))).toBe(a);
    expect(
      blindIndex('W1', 'EID', normalise('EID', '784 1990 1234567 1'), bk)
    ).toBe(a);
    expect(blindIndex('W1', 'EID', PLAIN, randomBytes(32))).not.toBe(a);
    expect(blindIndex('W1', 'ACCOUNT', PLAIN, bk)).not.toBe(a);
    expect(blindIndex('W1', 'EID', '784199012345672', bk)).not.toBe(a);
    expect(blindIndex('W1', 'EID', PLAIN, randomBytes(48))).toMatch(
      /^[0-9a-f]{64}$/
    );
  });
  it('is workspace-separated: the same value has a different index in every workspace', () => {
    expect(blindIndex('W1', 'EID', PLAIN, bk)).not.toBe(
      blindIndex('W2', 'EID', PLAIN, bk)
    );
    expect(blindIndex('W1', 'EID', PLAIN, bk)).toBe(
      blindIndex('W1', 'EID', PLAIN, bk)
    );
  });
  it('refuses a blind key under 32 bytes', () => {
    expect(() => blindIndex('W1', 'EID', PLAIN, randomBytes(31))).toThrow(
      'vault: invalid blind key'
    );
  });
});
