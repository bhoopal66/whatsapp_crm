// Ported from wacrm module 019c (vault), reference package 2026-10-18 (test/019c/tokenize.test.ts).
// A `workspace` here means the wacrm account id.
import { describe, it, expect } from 'vitest';
import { redact } from '@/lib/memory/redact';
import { tokenizeSensitive, type TokenVault } from './tokenize';
import type { VaultKind } from './crypto';

const CTX = {
  workspace: 'ws1',
  subject: { type: 'contact' as const, id: 'c1' },
  actor: 'app',
};
const ALPHA = 'ghjkmnpqrstvwxyz';

/** Records every put; tokens are distinct and in the vault token format. failAt: the 1-based put that throws. */
class FakeVault implements TokenVault {
  readonly puts: Array<{ kind: VaultKind; value: string; token: string }> = [];
  constructor(private readonly failAt = 0) {}
  async put(
    _ws: string,
    kind: VaultKind,
    value: string
  ): Promise<{ token: string; deduped: boolean }> {
    if (this.puts.length + 1 === this.failAt) throw new Error('db down');
    let n = this.puts.length;
    let tail = '';
    for (let i = 0; i < 26; i++) {
      tail += ALPHA[n % 16];
      n = Math.floor(n / 16);
    }
    const token = `vlt_${tail}`;
    this.puts.push({ kind, value, token });
    return { token, deduped: false };
  }
}

/** Tokenised text back to the 019b form: [KIND:token] -> [KIND], ACCOUNT -> [ACCT], PHONE -> [PHONE:last 3 digits]. */
function asRedacted(text: string, vault: FakeVault): string {
  return text.replace(
    /\[(EID|IBAN|PASSPORT|PHONE|ACCOUNT):(vlt_[ghjkmnpqrstvwxyz]{26})\]/g,
    (_m, kind: string, token: string) => {
      const put = vault.puts.find((p) => p.token === token)!;
      if (kind === 'ACCOUNT') return '[ACCT]';
      if (kind === 'PHONE')
        return `[PHONE:${put.value.replace(/\D/g, '').slice(-3)}]`;
      return `[${kind}]`;
    }
  );
}

const CORPUS: readonly string[] = [
  'EID 784-1990-1234567-1 on file',
  'IBAN AE07 0331 2345 6789 0123 456 please',
  'GB82 WEST 1234 5698 7654 32 transfer',
  'call +971 50 123 4567 or 04 123 4567',
  'whatsapp 971501234567 today',
  'passport N1234567 expires',
  'passport no: ab1234567',
  'account 0123456789 at the bank',
  'account 4111 1111 1111 1111',
  'acc no 4111111111111111 and acct 12345678',
  'OTP 482913 and pin 1234 and cvv 123',
  'mail a.b@example.com and card 4111-1111-1111-1111',
  '\uff17\uff18\uff14-1990-1234567-1 fullwidth',
  '784\u200b-1990-\u200d1234567-1 zero width',
  '\u0631\u0642\u0645 \u0627\u0644\u062d\u0633\u0627\u0628 123456789',
  '\u062c\u0648\u0627\u0632 \u0627\u0644\u0633\u0641\u0631 A1234567',
  '\u0660\u0665\u0660 123 4567 arabic-indic',
  '(04) 123 4567 office',
  'AED 500 4111 1111 1111 1111 paid',
  'dates 01/02/2024-05/02/2024 not a phone',
  'EID 784199012345671, acc 12345678, +44 20 7946 0958',
  'acct no: 9876543210 and a/c 1234567890',
  '00971 50 765 4321 and 050-765-4321',
  'IBAN AE07\u00a00331\u00a02345\u00a06789\u00a00123\u00a0456 nbsp',
  'verification code for login is 556677, account number 1234567',
  'hello world, nothing here',
  'card +4111111111111111 and call +5555555555554444',
  'card (4111) 1111 1111 1111, pay 4111 11 1111 1111 111',
  'iban AE0703312345678901234564111111111111111 ph 9714111111111111111',
  '',
];

describe('019c tokenize: parity with 019b redact()', () => {
  it('with the vault faked, every corpus string maps back to exactly what redact() produces', async () => {
    for (const s of CORPUS) {
      const vault = new FakeVault();
      const r = await tokenizeSensitive(s, CTX, vault);
      const red = redact(s);
      expect(red.ok).toBe(true);
      expect(r.ok, s).toBe(true);
      if (!r.ok || !red.ok) continue;
      expect(asRedacted(r.text, vault), s).toBe(red.text);
      expect(r.vaulted).toBe(vault.puts.length);
      const vaultedCounts = (
        ['EID', 'IBAN', 'PASSPORT', 'PHONE', 'ACCT'] as const
      ).reduce((n, k) => n + (red.redactions[k] ?? 0), 0);
      expect(r.vaulted, s).toBe(vaultedCounts);
    }
  });

  it('the corpus exercises every vaulted kind and every never-vaulted kind', async () => {
    const kinds = new Set<string>();
    for (const s of CORPUS) {
      const vault = new FakeVault();
      await tokenizeSensitive(s, CTX, vault);
      for (const p of vault.puts) kinds.add(p.kind);
      const red = redact(s);
      if (red.ok)
        for (const k of Object.keys(red.redactions)) kinds.add(`redact:${k}`);
    }
    for (const k of [
      'EID',
      'IBAN',
      'PASSPORT',
      'PHONE',
      'ACCOUNT',
      'redact:CARD',
      'redact:OTP',
      'redact:EMAIL',
    ])
      expect(kinds).toContain(k);
  });
});

describe('019c tokenize: refusals', () => {
  it('refuses input that already holds a sentinel (private-use) character, before any put', async () => {
    const vault = new FakeVault();
    const r = await tokenizeSensitive(
      'note \ue000 EID 784199012345671',
      CTX,
      vault
    );
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
    expect(vault.puts).toHaveLength(0);
    expect((await tokenizeSensitive('x\uf8ff', CTX, vault)).ok).toBe(false);
  });

  it('a failed put returns ok:false with no text at all, never partially tokenised text', async () => {
    const text =
      'EID 784199012345671, IBAN AE07 0331 2345 6789 0123 456, mobile +971 50 765 1234';
    for (const failAt of [1, 2, 3]) {
      const vault = new FakeVault(failAt);
      const r = await tokenizeSensitive(text, CTX, vault);
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty('text');
      if (!r.ok) {
        expect(r.reason).not.toMatch(/[0-9]{6}/);
        expect(r.reason).not.toContain('AE07');
      }
    }
  });

  it('a redactImpl that drops a sentinel yields ok:false', async () => {
    const vault = new FakeVault();
    const strip = (s: string) => ({
      ok: true as const,
      text: s.replace(/[\ue000-\uf8ff]/g, ''),
      redactions: {},
    });
    const r = await tokenizeSensitive('EID 784199012345671', CTX, vault, strip);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('text');
  });

  it('a redactImpl refusal is passed through as ok:false', async () => {
    const refuse = () => ({
      ok: false as const,
      refused: true as const,
      reason: 'nope',
    });
    expect(
      await tokenizeSensitive(
        'EID 784199012345671',
        CTX,
        new FakeVault(),
        refuse
      )
    ).toEqual({ ok: false, reason: 'nope' });
  });
});

describe('019c tokenize: a card number claimed by the ACCT or PHONE rule is [CARD], never vaulted', () => {
  it.each([
    ['account 41 1111 1111 1111 11', 'account [CARD]'],
    ['a/c 4111 1111 1111 111 1', 'a/c [CARD]'],
    ['card +4222222222222', 'card [CARD]'],
  ])('%j -> %j with no put', async (text, expected) => {
    const vault = new FakeVault();
    expect(await tokenizeSensitive(text, CTX, vault)).toEqual({
      ok: true,
      text: expected,
      vaulted: 0,
    });
    expect(vault.puts).toHaveLength(0);
  });

  it('a Luhn-invalid 16-digit account number and a +971 mobile are still vaulted', async () => {
    const vault = new FakeVault();
    const r = await tokenizeSensitive(
      'account 4111 1111 1111 1112, mobile +971501234567',
      CTX,
      vault
    );
    expect(r.ok).toBe(true);
    expect(vault.puts.map((p) => [p.kind, p.value])).toEqual([
      ['ACCOUNT', '4111111111111112'],
      ['PHONE', '+971501234567'],
    ]);
    if (r.ok) expect(r.vaulted).toBe(2);
  });

  it('a card next to vaulted values: only the card is [CARD], the count excludes it', async () => {
    const vault = new FakeVault();
    const r = await tokenizeSensitive(
      'EID 784199012345671 and account 41 1111 1111 1111 11',
      CTX,
      vault
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`EID [EID:${vault.puts[0]!.token}] and account [CARD]`);
    expect(r.vaulted).toBe(1);
    expect(vault.puts.map((p) => p.kind)).toEqual(['EID']);
  });
});

const D2_CARDS: ReadonlyArray<readonly [string, string]> = [
  ['card +4111111111111111', 'card [CARD]'],
  ['call +5555555555554444', 'call [CARD]'],
  ['card (4111) 1111 1111 1111', 'card [CARD]'],
  ['pay 4111 11 1111 1111 111', 'pay [CARD]'],
  ['iban AE0703312345678901234564111111111111111', 'iban AE[CARD]'],
  ['ph 9714111111111111111', 'ph [CARD]'],
];

describe('019c tokenize: D2 card catch-all formats are [CARD], never vaulted', () => {
  it.each(D2_CARDS)('%j -> %j with no put', async (text, expected) => {
    const vault = new FakeVault();
    expect(await tokenizeSensitive(text, CTX, vault)).toEqual({
      ok: true,
      text: expected,
      vaulted: 0,
    });
    expect(vault.puts).toHaveLength(0);
  });
});

// 019c H-B: a card written with a leading '+' / '00' was split into a PHONE span (vaulted) and plaintext digits.
const HB_CARDS: ReadonlyArray<readonly [string, string]> = [
  ['card +4111 1111 1111 1111', 'card [CARD]'],
  ['+4111-1111-1111-1111', '[CARD]'],
  ['card 004111 1111 1111 1111', 'card [CARD]'],
  [
    '+\u0664\u0661\u0661\u0661 \u0661\u0661\u0661\u0661 \u0661\u0661\u0661\u0661 \u0661\u0661\u0661\u0661',
    '[CARD]',
  ],
  ['call +5555 5555 5555 4444', 'call [CARD]'],
  ['amex +3782 822463 10005', 'amex [CARD]'],
  ['card 04111 1111 1111 1111', 'card [CARD]'],
  ['+9714111 1111 1111 1111', '[CARD]'],
  ['+971 4111 1111 1111 1111', '+971 [CARD]'],
  ['+86 138 0013 8002', '[CARD]'],
];

describe('019c tokenize: H-B a card split into a PHONE / ACCT span and plaintext is one [CARD], never vaulted', () => {
  it.each(HB_CARDS)('%j -> %j with no put', async (text, expected) => {
    const vault = new FakeVault();
    expect(await tokenizeSensitive(text, CTX, vault)).toEqual({
      ok: true,
      text: expected,
      vaulted: 0,
    });
    expect(vault.puts).toHaveLength(0);
  });

  it.each([
    ['+971 50 123 4567', 'PHONE', '+971501234567'],
    ['+971501234567', 'PHONE', '+971501234567'],
    ['00971 4 123 4567', 'PHONE', '0097141234567'],
    ['050 123 4567', 'PHONE', '0501234567'],
    ['account 123456789012', 'ACCOUNT', '123456789012'],
    ['IBAN AE07 0331 2345 6789 0123 456', 'IBAN', 'AE070331234567890123456'],
    ['EID 784-1990-1234567-1', 'EID', '784199012345671'],
    // 15 Luhn-valid digits starting 784 (an Emirates ID shape): not a card, the phone part is still vaulted.
    ['+784 1990 1234 5676', 'PHONE', '+78419901234'],
  ] as const)('%j is still vaulted as %s', async (text, kind, value) => {
    const vault = new FakeVault();
    const r = await tokenizeSensitive(text, CTX, vault);
    expect(r.ok).toBe(true);
    expect(vault.puts.map((p) => [p.kind, p.value])).toEqual([[kind, value]]);
    if (r.ok) expect(r.text).not.toContain('[CARD]');
  });
});
