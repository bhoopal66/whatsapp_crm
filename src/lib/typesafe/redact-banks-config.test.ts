import { describe, expect, it } from 'vitest';
import {
  containsRawIdentifier,
  detectLanguage,
  redact,
  redactDeep,
} from './redact';
import { detectBanks } from './banks';
import { DEFAULT_CONFIG, loadConfig } from './config';

describe('redact', () => {
  const cases: [string, string, string][] = [
    ['Emirates ID dashed', 'My EID is 784-1985-1234567-1 ok', '[EID]'],
    ['Emirates ID plain', '784198512345671', '[EID]'],
    ['UAE IBAN spaced', 'IBAN AE07 0331 2345 6789 0123 456', '[IBAN]'],
    ['UAE IBAN compact', 'AE070331234567890123456', '[IBAN]'],
    ['Visa test card', 'card 4111 1111 1111 1111 exp', '[CARD]'],
    ['Mobile +971', 'call +971 50 123 4567', '[PHONE]'],
    ['Mobile 00971', '00971501234567', '[PHONE]'],
    ['Mobile local', 'my number 050-123-4567', '[PHONE]'],
    ['Landline local', 'office 04 123 4567', '[PHONE]'],
    ['Arabic-Indic digits', 'رقمي ٠٥٠١٢٣٤٥٦٧', '[PHONE]'],
    ['Foreign mobile', '+91 98765 43210', '[PHONE]'],
    ['Email', 'mail me at ali.k@example.ae', '[EMAIL]'],
    ['Passport', 'passport N1234567', '[DOC]'],
    ['Trade licence', 'Trade licence no: 1234567', '[LICENCE]'],
  ];
  for (const [name, input, token] of cases) {
    it(`redacts ${name}`, () => {
      const out = redact(input).text;
      expect(out).toContain(token);
      expect(containsRawIdentifier(out)).toBe(false);
    });
  }

  it('keeps amounts, years and ordinary words intact', () => {
    const s =
      'Turnover AED 2,500,000 since 2019, need 500k, please read the license agreement';
    expect(redact(s).text).toBe(s);
  });

  it('does not treat a non-Luhn 16-digit number as a card', () => {
    expect(redact('ref 1234 5678 9012 3456').text).not.toContain('[CARD]');
  });

  it('redacts nested structures', () => {
    const out = redactDeep({
      a: ['call 0501234567'],
      b: { c: 'x@y.com' },
      n: 5,
    });
    expect(out).toEqual({ a: ['call [PHONE]'], b: { c: '[EMAIL]' }, n: 5 });
  });

  it('tags language', () => {
    expect(detectLanguage('I want to open an account')).toBe('en');
    expect(detectLanguage('أريد فتح حساب تجاري')).toBe('ar');
    expect(detectLanguage('أريد فتح account للشركة please')).toBe('mixed');
  });
});

describe('bank dictionary', () => {
  it('finds partner and non-partner banks in English', () => {
    const hits = detectBanks('Is Mashreq better than Emirates NBD or FAB?');
    expect(hits).toEqual(
      expect.arrayContaining([
        { code: 'MASHREQ', partner: true },
        { code: 'ENBD', partner: false },
        { code: 'FAB', partner: false },
      ])
    );
  });
  it('finds banks in Arabic with spelling variants', () => {
    expect(
      detectBanks('هل بنك أبوظبي الأول أفضل؟').map((h) => h.code)
    ).toContain('FAB');
    expect(
      detectBanks('أريد حساب في بنك رأس الخيمة').map((h) => h.code)
    ).toContain('RAKBANK');
  });
  it('does not confuse common Arabic words or free-zone names with banks', () => {
    expect(detectBanks('رؤية الشركة واضحة')).toEqual([]); // "vision"
    expect(detectBanks('We are licensed in RAK free zone')).toEqual([]);
    expect(detectBanks('fabulous service')).toEqual([]); // FAB is case-sensitive acronym
  });
});

describe('config', () => {
  it('without an API key, nothing is available', () => {
    const c = loadConfig({});
    expect(c.enabled).toEqual({
      triage: false,
      guardrail: false,
      passages: false,
      eligibility: false,
    });
    expect(c.shadow).toBe(false);
    expect(c.accounts).toBe('*');
    expect(c.guardrailFailMode).toBe('hold');
    expect(c.model).toBe(DEFAULT_CONFIG.model);
  });
  it('with an API key every check is available; each account decides in Settings', () => {
    const c = loadConfig({
      TYPESAFE_API_KEY: 'k',
      TS_LOG_HASH_KEY: 'x'.repeat(32),
    });
    expect(c.enabled).toEqual({
      triage: true,
      guardrail: true,
      passages: true,
      eligibility: true,
    });
    expect(c.shadow).toBe(false);
    expect(
      loadConfig({
        TYPESAFE_API_KEY: 'k',
        TS_LOG_HASH_KEY: 'x'.repeat(32),
        TS_ENABLED_PASSAGES: 'false',
      }).enabled.passages
    ).toBe(false);
  });
  it('rejects floating model aliases and bad values', () => {
    expect(() => loadConfig({ TYPESAFE_MODEL: 'jev-latest' })).toThrow(
      /pinned/
    );
    expect(() => loadConfig({ TS_SHADOW: 'maybe' })).toThrow();
    expect(() => loadConfig({ TS_GUARDRAIL_FAIL_MODE: 'drop' })).toThrow();
    expect(() => loadConfig({ TS_TIMEOUT_MS: '-5' })).toThrow();
  });
  it('reads switches', () => {
    const c = loadConfig({
      TS_ENABLED_TRIAGE: 'true',
      TS_SHADOW: 'false',
      TS_GUARDRAIL_FAIL_MODE: 'send',
      TYPESAFE_API_KEY: 'k',
      TS_ACCOUNT_IDS: '*',
      TS_LOG_HASH_KEY: 'x'.repeat(32),
    });
    expect(c.enabled.triage).toBe(true);
    expect(c.shadow).toBe(false);
    expect(c.guardrailFailMode).toBe('send');
  });
  it('refuses an enabled check without an API key', () => {
    expect(() => loadConfig({ TS_ENABLED_GUARDRAIL: 'true' })).toThrow(
      /TYPESAFE_API_KEY/
    );
    expect(() => loadConfig({ TS_ENABLED_GUARDRAIL: 'false' })).not.toThrow();
  });
  it('keeps Arabic and mixed-language decisions in shadow by default', () => {
    expect(loadConfig({}).shadowLanguages).toEqual(['ar', 'mixed', 'other']);
    expect(loadConfig({ TS_SHADOW_LANGUAGES: 'none' }).shadowLanguages).toEqual(
      []
    );
    expect(
      loadConfig({ TS_SHADOW_LANGUAGES: 'mixed' }).shadowLanguages
    ).toEqual(['mixed']);
    expect(() => loadConfig({ TS_SHADOW_LANGUAGES: 'fr' })).toThrow();
  });
  it('reads per-check shadow overrides', () => {
    const c = loadConfig({ TS_SHADOW: 'false', TS_SHADOW_GUARDRAIL: 'true' });
    expect(c.shadowOverride).toEqual({ guardrail: true });
  });
});
