// Ported from wacrm module 019c (vault), reference package 2026-10-18 (test/019c/tokenize.pg.test.ts).
// The reference ran these assertions against PgVaultStore on a real Postgres; wacrm's vitest has no database, so they
// run against MemoryVault below, which does what the store's put does in TypeScript (normalise -> blind index ->
// AES-256-GCM with AAD 'workspace|kind|blind_index', dedupe on the blind index) and keeps the rows in a Map. The DB-only
// parts (vault roles, the reveal audit and rate limit) are the later store job's. A `workspace` means the wacrm
// account id.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { redact } from '@/lib/memory/redact';
import {
  blindIndex,
  decrypt,
  encrypt,
  normalise,
  vaultAad,
  type EncryptedPayload,
  type KeyProvider,
  type VaultKind,
} from './crypto';
import { tokenizeSensitive, type TokenVault } from './tokenize';
import type { VaultSubject } from './types';

const KEY = randomBytes(32);
const keys: KeyProvider = {
  currentKeyId: () => 'k1',
  getKey: (id) => {
    if (id !== 'k1') throw new Error('unknown key');
    return KEY;
  },
};
const ALPHA = 'ghjkmnpqrstvwxyz';

interface Row {
  readonly workspace: string;
  readonly kind: VaultKind;
  readonly index: string;
  readonly payload: EncryptedPayload;
  readonly subject: VaultSubject;
}

/** In-memory TokenVault: one live item per (workspace, kind, blind index of the normalised value). */
class MemoryVault implements TokenVault {
  private readonly byIndex = new Map<string, string>();
  private readonly byToken = new Map<string, Row>();
  constructor(
    private readonly keyProvider: KeyProvider,
    private readonly blindKey: Buffer
  ) {}

  get size(): number {
    return this.byToken.size;
  }

  async put(
    workspace: string,
    kind: VaultKind,
    value: string,
    subject: VaultSubject
  ): Promise<{ token: string; deduped: boolean }> {
    const norm = normalise(kind, value);
    const index = blindIndex(workspace, kind, norm, this.blindKey);
    const at = `${workspace}|${kind}|${index}`;
    const live = this.byIndex.get(at);
    if (live) return { token: live, deduped: true };
    const payload = encrypt(
      norm,
      this.keyProvider,
      vaultAad(workspace, kind, index)
    );
    let token = 'vlt_';
    for (const b of randomBytes(26)) token += ALPHA[b % 16];
    this.byIndex.set(at, token);
    this.byToken.set(token, { workspace, kind, index, payload, subject });
    return { token, deduped: false };
  }

  reveal(
    workspace: string,
    token: string
  ): { ok: true; kind: VaultKind; value: string } | { ok: false } {
    const row = this.byToken.get(token);
    if (!row || row.workspace !== workspace) return { ok: false };
    const value = decrypt(
      row.payload,
      this.keyProvider,
      vaultAad(workspace, row.kind, row.index)
    );
    return { ok: true, kind: row.kind, value };
  }
}

const CTX = {
  workspace: 'ws1',
  subject: { type: 'contact' as const, id: 'c-tok' },
  actor: 'app',
};
const PLACEHOLDER = /\[(EID|IBAN|PASSPORT|PHONE|ACCOUNT):([^\]]*)\]/g;

const store = new MemoryVault(keys, randomBytes(32));
const itemCount = async () => store.size;

describe('019c tokenize against an in-memory vault', () => {
  it('EID, IBAN, phone, passport and account are vaulted as [KIND:vlt_...]; raw values are gone; reveal gives the normalised original', async () => {
    const text =
      'EID 784-1990-7654321-2, IBAN AE07 0331 2345 6789 0123 456, mobile +971 50 765 1234, passport n7654321, account 0123 4567 8901.';
    const before = await itemCount();
    const r = await tokenizeSensitive(text, CTX, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vaulted).toBe(5);
    expect(await itemCount()).toBe(before + 5);
    const found = [...r.text.matchAll(PLACEHOLDER)].map((m) => ({
      kind: m[1]!,
      token: m[2]!,
    }));
    expect(found.map((f) => f.kind)).toEqual([
      'EID',
      'IBAN',
      'PHONE',
      'PASSPORT',
      'ACCOUNT',
    ]);
    for (const f of found)
      expect(f.token).toMatch(/^vlt_[ghjkmnpqrstvwxyz]{26}$/);
    expect(r.text.replace(PLACEHOLDER, '[X]')).toBe(
      'EID [X], IBAN [X], mobile [X], passport [X], account [X].'
    );
    for (const raw of [
      '784-1990-7654321-2',
      '784199076543212',
      '7654321',
      'AE07 0331',
      'AE070331234567890123456',
      '0331',
      '765 1234',
      '971507651234',
      'n7654321',
      'N7654321',
      '0123 4567 8901',
      '012345678901',
    ]) {
      expect(r.text).not.toContain(raw);
    }
    const expected: Record<string, string> = {
      EID: '784199076543212',
      IBAN: 'AE070331234567890123456',
      PHONE: '971507651234',
      PASSPORT: 'N7654321',
      ACCOUNT: '012345678901',
    };
    for (const f of found) {
      expect(store.reveal('ws1', f.token)).toEqual({
        ok: true,
        kind: f.kind,
        value: expected[f.kind],
      });
    }
  });

  it('card numbers, OTP, PIN and CVV are redacted and never vaulted (vault row count unchanged)', async () => {
    const text =
      'card 4111 1111 1111 1111, OTP 482913, pin 9876, cvv 123, card 5500-0000-0000-0004';
    const before = await itemCount();
    const r = await tokenizeSensitive(text, CTX, store);
    expect(r).toEqual({
      ok: true,
      text: 'card [CARD], OTP [OTP], pin [OTP], cvv [OTP], card [CARD]',
      vaulted: 0,
    });
    expect(await itemCount()).toBe(before);
  });

  it('an account cue in front of a card number is a card: redacted, not vaulted as ACCOUNT', async () => {
    const before = await itemCount();
    const r = await tokenizeSensitive(
      'account 4111 1111 1111 1111',
      CTX,
      store
    );
    expect(r).toEqual({ ok: true, text: 'account [CARD]', vaulted: 0 });
    expect(await itemCount()).toBe(before);
  });

  it.each([
    ['account 41 1111 1111 1111 11', 'account [CARD]'],
    ['a/c 4111 1111 1111 111 1', 'a/c [CARD]'],
    ['card +4222222222222', 'card [CARD]'],
  ])(
    'a card number the card rule misses (%j) is [CARD]: zero vault rows',
    async (text, expected) => {
      const before = await itemCount();
      expect(await tokenizeSensitive(text, CTX, store)).toEqual({
        ok: true,
        text: expected,
        vaulted: 0,
      });
      expect(await itemCount()).toBe(before);
    }
  );

  it('a Luhn-invalid 16-digit account number and a +971 mobile are still vaulted and reveal', async () => {
    const before = await itemCount();
    const r = await tokenizeSensitive(
      'account 4111 1111 1111 1112, mobile +971501234567',
      CTX,
      store
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vaulted).toBe(2);
    expect(await itemCount()).toBe(before + 2);
    const found = [...r.text.matchAll(PLACEHOLDER)].map((m) => ({
      kind: m[1]!,
      token: m[2]!,
    }));
    expect(found.map((f) => f.kind)).toEqual(['ACCOUNT', 'PHONE']);
    expect(store.reveal('ws1', found[0]!.token)).toEqual({
      ok: true,
      kind: 'ACCOUNT',
      value: '4111111111111112',
    });
    expect(store.reveal('ws1', found[1]!.token)).toEqual({
      ok: true,
      kind: 'PHONE',
      value: '971501234567',
    });
  });

  it('email stays [EMAIL] next to a vaulted value; output equals redact() apart from the vault placeholder', async () => {
    const text = 'write to a.b@example.com about EID 784-1985-1111111-1';
    const r = await tokenizeSensitive(text, CTX, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.replace(PLACEHOLDER, '[$1]')).toBe(
      (redact(text) as { text: string }).text
    );
  });

  it('a value the vault normaliser rejects fails the whole call: ok:false, no text', async () => {
    const r = await tokenizeSensitive(
      'EID 784-1985-2222222-2 and landline 01 234 5678',
      CTX,
      store
    );
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('text');
  });
});
