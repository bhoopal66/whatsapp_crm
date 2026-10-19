import { describe, it, expect } from 'vitest';
import { redact, luhnValid, foldDigits } from './redact';

// Seeded PRNG so the property runs are reproducible.
function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
}
const rand = rng(19_02);
const digit = () => String(Math.floor(rand() * 10));
const digits = (n: number) => Array.from({ length: n }, digit).join('');
const toArabic = (s: string) =>
  s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const toPersian = (s: string) =>
  s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
const variants = (s: string) => [s, toArabic(s), toPersian(s)];
function luhnCard(len = 16): string {
  const body = '4' + digits(len - 2);
  for (let c = 0; c < 10; c++) if (luhnValid(body + c)) return body + c;
  throw new Error('unreachable');
}
const group = (s: string, sep: string) => s.match(/.{1,4}/g)!.join(sep);
const ok = (t: string) => {
  const r = redact(t);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const rawDigitsGone = (out: string, raw: string) =>
  expect(foldDigits(out).replace(/\D/g, '')).not.toContain(
    raw.replace(/\D/g, '')
  );

describe('019b G4 redaction', () => {
  it('Emirates ID in dashed, spaced, compact and Arabic-Indic forms', () => {
    for (let i = 0; i < 20; i++) {
      const eid = `784-${1970 + Math.floor(rand() * 50)}-${digits(7)}-${digit()}`;
      for (const form of [eid, eid.replace(/-/g, ' '), eid.replace(/-/g, '')]) {
        for (const v of variants(form)) {
          const r = ok(`Customer EID ${v} verified`);
          expect(r.text).toBe('Customer EID [EID] verified');
          expect(r.redactions.EID).toBe(1);
        }
      }
    }
  });

  it('Luhn-valid cards spaced, dashed, compact, Arabic-Indic; a non-Luhn 16-digit number is not a card', () => {
    for (let i = 0; i < 30; i++) {
      const card = luhnCard(16);
      for (const form of [card, group(card, ' '), group(card, '-')]) {
        for (const v of variants(form)) {
          const r = ok(`paid with ${v} yesterday`);
          expect(r.text).toBe('paid with [CARD] yesterday');
          rawDigitsGone(r.text, card);
        }
      }
      const bad = card.slice(0, 15) + String((Number(card[15]) + 1) % 10);
      expect(luhnValid(bad)).toBe(false);
      const ref = `reference ${group(bad, ' ')} on file`;
      expect(ok(ref).text).toBe(ref);
    }
    expect(ok('card 4111 1111 1111 1111 12 left').text).toBe(
      'card [CARD] 12 left'
    );
  });

  it('IBAN (AE and generic mod-97) is redacted', () => {
    expect(ok('IBAN AE07 0331 2345 6789 0123 456 please').text).toBe(
      'IBAN [IBAN] please'
    );
    expect(
      ok(`iban ${toArabic('AE070331234567890123456')}`.replace('٠٧', '07')).text
    ).toBe('iban [IBAN]');
    expect(ok('pay GB82 WEST 1234 5698 7654 32 is the account').text).toBe(
      'pay [IBAN] is the account'
    );
  });

  it('OTP / PIN / CVV, account and passport cues, email and phone', () => {
    for (const v of variants('482913')) {
      expect(ok(`your OTP is ${v}`).text).toBe('your OTP is [OTP]');
      expect(ok(`رمز التحقق ${v}`).text).toBe('رمز التحقق [OTP]');
    }
    expect(ok('PIN: 4321, CVV 123').text).toBe('PIN: [OTP], CVV [OTP]');
    expect(ok('account no. 0123456789 at the bank').text).toBe(
      'account no. [ACCT] at the bank'
    );
    expect(ok('رقم الحساب ١٢٣٤٥٦٧٨٩٠').text).toBe('رقم الحساب [ACCT]');
    expect(ok('passport no N1234567 expires').text).toBe(
      'passport no [PASSPORT] expires'
    );
    expect(ok('mail Ahmed.K+crm@bank-x.ae today').text).toBe(
      'mail [EMAIL] today'
    );
    for (const v of variants('+971 50 123 4567'))
      expect(ok(`call ${v} now`).text).toBe('call [PHONE:567] now');
    expect(ok('call 050 123 4567 or 04 234 5678').text).toBe(
      'call [PHONE:567] or [PHONE:678]'
    );
    const r = ok('OTP 1234 mail a@b.co');
    expect(r.redactions).toEqual({ OTP: 1, EMAIL: 1 });
  });

  // M4: the cue may touch the value and up to 3 words may sit between cue and value.
  it('OTP / PIN / CVV cues glued to the value or a few words before it', () => {
    for (const v of variants('482913')) {
      expect(ok(`your OTP for login is ${v}`).text).toBe(
        'your OTP for login is [OTP]'
      );
      expect(ok(`OTP${v}`).text).toBe('OTP[OTP]');
    }
    expect(ok('cvv of the card 123').text).toBe('cvv of the card [OTP]');
    expect(ok('PIN: 4321').text).toBe('PIN: [OTP]');
    const arCue =
      '\u0631\u0645\u0632 \u0627\u0644\u062a\u062d\u0642\u0642 \u0627\u0644\u062e\u0627\u0635 \u0628\u0643'; // Arabic "your verification code"
    expect(ok(`${arCue} 482913`).text).toBe(`${arCue} [OTP]`);
    const r = ok('OTP for login is 482913, cvv of the card 123');
    expect(r.redactions).toEqual({ OTP: 2 });
  });

  it('OTP cue guards: no value, a longer word, or more than 3 words in between stay unchanged', () => {
    for (const t of [
      'OTP is required',
      'OTP is required for login',
      'pinned 1234 to the board',
      'pin the note about the 1500 rate',
    ]) {
      expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
    }
  });

  it('plain business text (English, Arabic, mixed digits) is unchanged', () => {
    const texts = [
      'Customer agreed a 12 month tenor at 7.5% on an AED 250,000 limit; follow up on 15/11/2026.',
      'وافق العميل على تمويل بقيمة ٢٥٠٬٠٠٠ درهم لمدة ١٢ شهراً',
      'Case 2026-0417: bank asked for 3 years of audited FS and the trade licence (no. pending).',
      'Meeting at 10:30, invoice INV-88213 approved, PO 4500012345 raised.',
    ];
    for (const t of texts)
      expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
  });

  it('never throws: a non-string or a throwing input yields a refusal', () => {
    expect(redact(42 as unknown as string)).toMatchObject({
      ok: false,
      refused: true,
    });
    const evil = {
      toString() {
        throw new Error('x');
      },
    };
    expect(redact(evil as unknown as string)).toMatchObject({
      ok: false,
      refused: true,
    });
  });
});

// H1: text that is PII only after NFKC / invisible-character stripping / digit folding.
const shiftDigits = (s: string, zero: number) =>
  s.replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));
const fullwidth = (s: string) => shiftDigits(s, 0xff10);
const mathBold = (s: string) => shiftDigits(s, 0x1d7ce);
const devanagari = (s: string) => shiftDigits(s, 0x0966);

describe('019b redaction on the normalised view (NFKC, invisible characters, all Nd digits)', () => {
  it('fullwidth, mathematical bold and zero-width-joined card digits are redacted', () => {
    for (let i = 0; i < 10; i++) {
      const card = luhnCard(16);
      for (const v of [
        fullwidth(card),
        mathBold(card),
        group(card, '\u200b'),
        group(fullwidth(card), ' '),
        group(card, ' \u200d'),
      ]) {
        const r = ok(`paid with ${v} yesterday`);
        expect(r.text).toBe('paid with [CARD] yesterday');
        expect(r.redactions).toEqual({ CARD: 1 });
      }
    }
    expect(ok('4111\u200b1111\u200b1111\u200b1111').text).toBe('[CARD]');
  });

  it('fullwidth, zero-width-separated and Devanagari Emirates IDs are redacted', () => {
    const eid = '784-1990-1234567-1';
    for (const v of [
      fullwidth(eid),
      fullwidth(eid.replace(/-/g, '')),
      '784\u200b1990\u200b1234567\u200b1',
      '784-\u200c1990-\u2060' + '1234567-\ufeff1',
      devanagari(eid),
    ]) {
      expect(ok(`EID ${v} ok`).text).toBe('EID [EID] ok');
    }
  });

  it('an email with a fullwidth at sign is redacted', () => {
    expect(ok('mail john\uff20gmail.com now').text).toBe('mail [EMAIL] now');
    expect(ok('mail \uff4a\uff4f\uff48\uff4e@gmail.com').text).toBe(
      'mail [EMAIL]'
    );
  });

  it('the original text outside a redacted span is kept as given (not normalised)', () => {
    const r = ok(
      'note\u200b \uff21\uff25\uff24 500: card 4111\u200b1111\u200b1111\u200b1111 \u00a0end'
    );
    expect(r.text).toBe(
      'note\u200b \uff21\uff25\uff24 500: card [CARD] \u00a0end'
    );
    expect(ok('\uff21\uff25\uff24 250,000 \u2460 \ufb01le').text).toBe(
      '\uff21\uff25\uff24 250,000 \u2460 \ufb01le'
    );
  });
});

// H2: separators beyond a single ASCII space / dash, a number in front of the value, WhatsApp phone formats.
// D2: every dash (\p{Pd}), minus and non-breaking hyphen separate card / EID / IBAN groups; phones take dots, slashes and
// dashes, but an unspaced date range is not a phone.
describe('019b redaction dash separators and dotted / slashed phones', () => {
  const dashes = ['\u2013', ' \u2013 ', '\u2014', '\u2212', '\u2011', '\u2010'];
  it('cards with en dash spaced and unspaced (and other dashes), Emirates IDs with en dashes, IBAN with en dashes', () => {
    for (let i = 0; i < 5; i++) {
      const card = luhnCard(16);
      for (const sep of dashes) {
        const r = ok(`paid with ${group(card, sep)} yesterday`);
        expect(r.text).toBe('paid with [CARD] yesterday');
        rawDigitsGone(r.text, card);
      }
    }
    expect(ok('card 4111\u20131111\u20131111\u20131111 ok').text).toBe(
      'card [CARD] ok'
    );
    expect(ok('card 4111 \u2013 1111 \u2013 1111 \u2013 1111 ok').text).toBe(
      'card [CARD] ok'
    );
    for (const sep of dashes)
      expect(
        ok(`EID ${['784', '1990', '1234567', '1'].join(sep)} ok`).text
      ).toBe('EID [EID] ok');
    expect(
      ok('IBAN AE07\u20130331\u20132345\u20136789\u20130123\u2013456 ok').text
    ).toBe('IBAN [IBAN] ok');
  });

  it('dotted, slashed and dashed phones are redacted', () => {
    expect(ok('call 050.123.4567 now').text).toBe('call [PHONE:567] now');
    expect(ok('call +971.50.123.4567 now').text).toBe('call [PHONE:567] now');
    expect(ok('call 00971/50/1234567 now').text).toBe('call [PHONE:567] now');
    expect(ok('call 050\u2013123\u20134567 now').text).toBe(
      'call [PHONE:567] now'
    );
    expect(ok('call (04).234.5678 now').text).toBe('call [PHONE:678] now');
  });

  it('unspaced date ranges, prices and spaced AED amounts stay unchanged', () => {
    const keep = [
      'period 01/02/2024-05/02/2024 agreed',
      'period 05.01.2024-06.01.2024 agreed',
      'period 01/02/2024\u201305/02/2024 agreed',
      'period 01.02.2024 - 05.02.2024 agreed',
      'fee AED 1.250.000.00 or USD 12.99/month, unit 0.75',
      'limit AED 1 250 000 and AED 12 500 000.00 approved',
      'AED 500 1234 5678 paid',
    ];
    for (const t of keep)
      expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
    // DD/10/2026 - DD/11/2026 for every day pair stays unchanged
    const pad = (n: number) => String(n).padStart(2, '0');
    for (let a = 1; a <= 28; a++) {
      for (const b of [1, 15, 28]) {
        const t = `period ${pad(a)}/10/2026 - ${pad(b)}/11/2026 agreed`;
        expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
      }
    }
  });
});

describe('019b redaction separators, re-anchoring and phone formats', () => {
  const seps = ['\u00a0', '\u202f', '.', '_', '/', '  ', ' - ', '\u00a0\u00a0'];
  it('cards, Emirates IDs and IBANs with NBSP / narrow NBSP / dot / underscore / slash / double separators', () => {
    for (let i = 0; i < 10; i++) {
      const card = luhnCard(16);
      for (const sep of seps) {
        const r = ok(`paid with ${group(card, sep)} yesterday`);
        expect(r.text).toBe('paid with [CARD] yesterday');
        rawDigitsGone(r.text, card);
      }
    }
    for (const sep of seps) {
      expect(
        ok(`EID ${['784', '1990', '1234567', '1'].join(sep)} ok`).text
      ).toBe('EID [EID] ok');
      expect(ok(`IBAN ${group('AE070331234567890123456', sep)} ok`).text).toBe(
        'IBAN [IBAN] ok'
      );
      expect(ok(`pay ${group('GB82WEST12345698765432', sep)} ok`).text).toBe(
        'pay [IBAN] ok'
      );
    }
    expect(ok('EID 784.1990.1234567.1').text).toBe('EID [EID]');
    expect(ok('IBAN AE07  0331  2345  6789  0123  456').text).toBe(
      'IBAN [IBAN]'
    );
  });

  it('a number in front of a card or IBAN does not hide it (re-anchoring)', () => {
    expect(ok('ref 1 4111 1111 1111 1111').text).toBe('ref 1 [CARD]');
    expect(ok('AED 500 4111 1111 1111 1111').text).toBe('AED 500 [CARD]');
    expect(ok('AED 500.4111.1111.1111.1111 paid').text).toBe(
      'AED 500.[CARD] paid'
    );
    for (let i = 0; i < 30; i++) {
      const card = luhnCard(16);
      const lead = String(1 + Math.floor(rand() * 999));
      const r = ok(`amount ${lead} ${group(card, ' ')} done`);
      expect(r.text).toBe(`amount ${lead} [CARD] done`);
    }
    expect(ok('ref AB12 GB82 WEST 1234 5698 7654 32').text).toBe(
      'ref AB12 [IBAN]'
    );
  });

  it('WhatsApp phone formats: bare 971 id, spaced 971, parenthesised local', () => {
    expect(ok('wa_id 971501234567 replied').text).toBe(
      'wa_id [PHONE:567] replied'
    );
    expect(ok('call 971 50 123 4567 now').text).toBe('call [PHONE:567] now');
    expect(ok('call (050) 123 4567 or (04) 234 5678').text).toBe(
      'call [PHONE:567] or [PHONE:678]'
    );
  });

  it('prices, dates, date ranges, phone pairs and non-Luhn numbers stay unchanged', () => {
    const keep = [
      'AED 500 1234 5678',
      'AED 500 1234 5678 paid on 15/11/2026',
      'limit AED 1.250.000 at 7.5%',
    ];
    for (let i = 0; i < 20; i++) {
      const card = luhnCard(16);
      const bad = card.slice(0, 15) + String((Number(card[15]) + 1) % 10);
      // Not a card; a group that starts with 00 can still read as an international phone (pre-existing rule).
      for (const sep of seps)
        expect(
          ok(`reference ${group(bad, sep)} on file`).redactions.CARD
        ).toBeUndefined();
    }
    // Date ranges and phone pairs whose digits happen to pass Luhn are still not cards.
    const pad = (n: number) => String(n).padStart(2, '0');
    let ranges = 0;
    for (let d = 1; d <= 28 * 28 && ranges < 5; d++) {
      const s = `${pad(1 + (d % 28))}/10/2026 - ${pad(1 + (Math.floor(d / 28) % 28))}/11/2026`;
      if (luhnValid(s.replace(/\D/g, ''))) {
        keep.push(`period ${s} agreed`);
        ranges++;
      }
    }
    expect(ranges).toBeGreaterThan(0);
    for (const t of keep)
      expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
    let pairs = 0;
    for (let n = 1000; n < 1100 && pairs < 5; n++) {
      const t = `04 234 ${n} 04 234 ${n + 1}`;
      if (luhnValid(t.replace(/\D/g, ''))) {
        expect(ok(t).text).toMatch(/^\[PHONE:\d{3}\] \[PHONE:\d{3}\]$/);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

// 019c D2: card formats the CARD rule misses are caught by the final catch-all pass.
const D2_CARDS: ReadonlyArray<readonly [string, string]> = [
  ['card +4111111111111111', 'card [CARD]'],
  ['call +5555555555554444', 'call [CARD]'],
  ['card (4111) 1111 1111 1111', 'card [CARD]'],
  ['pay 4111 11 1111 1111 111', 'pay [CARD]'],
  ['iban AE0703312345678901234564111111111111111', 'iban AE[CARD]'],
  ['ph 9714111111111111111', 'ph [CARD]'],
];
describe('019c redaction card catch-all', () => {
  it.each(D2_CARDS)('%j -> %j', (text, expected) => {
    expect(ok(text)).toEqual({
      ok: true,
      text: expected,
      redactions: { CARD: 1 },
    });
  });

  it('TRNs, parenthesised dates and phones are unchanged; a card in parentheses keeps the parentheses', () => {
    for (const t of [
      'TRN 100123456789002 on invoice',
      'period (01/10/2026) - (05/11/2026) agreed',
    ]) {
      expect(ok(t)).toEqual({ ok: true, text: t, redactions: {} });
    }
    expect(ok('call +971 50 123 4567 or (04) 234 5678').text).toBe(
      'call [PHONE:567] or [PHONE:678]'
    );
    expect(ok('note (4111 1111 1111 1111) end').text).toBe('note ([CARD]) end');
  });
});

// 019c H-B: a card written with a leading '+' / '00' was redacted as a phone plus plaintext digits.
describe('019c redaction whole-run card claim', () => {
  it.each([
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
  ])('%j -> %j', (text, expected) => {
    expect(ok(text)).toEqual({
      ok: true,
      text: expected,
      redactions: { CARD: 1 },
    });
  });

  it.each([
    ['+971 50 123 4567', '[PHONE:567]', { PHONE: 1 }],
    ['+971501234567', '[PHONE:567]', { PHONE: 1 }],
    ['00971 4 123 4567', '[PHONE:567]', { PHONE: 1 }],
    ['050 123 4567', '[PHONE:567]', { PHONE: 1 }],
    ['account 123456789012', 'account [ACCT]', { ACCT: 1 }],
    ['IBAN AE07 0331 2345 6789 0123 456', 'IBAN [IBAN]', { IBAN: 1 }],
    ['EID 784-1990-1234567-1', 'EID [EID]', { EID: 1 }],
    ['+784 1990 1234 5676', '[PHONE:234] 5676', { PHONE: 1 }],
  ])('%j is unchanged by the claim: %j', (text, expected, counts) => {
    expect(ok(text)).toEqual({ ok: true, text: expected, redactions: counts });
  });
});
