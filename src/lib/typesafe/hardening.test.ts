/**
 * Regression cases from the production review of the module 013 port
 * (2026-09-29). Each block names the finding it pins down.
 */
import { describe, expect, it } from 'vitest';
import { TRIAGE_QUESTIONS } from './questions/triage';
import { GUARDRAIL_QUESTIONS } from './questions/guardrail';
import { validateAnswers, MAX_REQUEST_CHARS } from './client';
import { loadConfig } from './config';
import { DEFAULT_THRESHOLDS, validateThresholds } from './policy';
import {
  containsRawIdentifier,
  detectLanguage,
  normaliseDigits,
  redact,
} from './redact';
import { detectBanks } from './banks';
import { extractFigures, unsupportedFigures } from './checks/guardrail';
import { approvedDb, makeLayer, makeSim } from './test-helpers';

const KEY = 'k'.repeat(32);
const ON = {
  TS_ENABLED_TRIAGE: 'true',
  TYPESAFE_API_KEY: 'key',
  TS_ACCOUNT_IDS: '*',
  TS_LOG_HASH_KEY: KEY,
};

describe('redaction gaps (TS-INT-7, SEC-6)', () => {
  it.each([
    ['slash-separated Emirates ID', 'my id 784/1990/1234567/1'],
    ['card with wide separators', 'card 4111 - 1111 - 1111 - 1111'],
    ['slash-separated mobile', 'call 050/1234567'],
    ['identifier next to an amount', 'Invoice 998877665544, 5000 AED'],
    ['identifier after an amount', 'AED 500 123456789012 is the ref'],
    ['a name ending in "aed"', 'Saed 1019283746501'],
    ['fullwidth digits', 'call ０５０１２３４５６７'],
    ['Devanagari digits', 'call ०५०१२३४५६७'],
    ['a long number written as the amount', 'AED 1234567890123 transfer'],
    ['a long number before the currency', 'ref 1234567890123 AED'],
  ])('redacts %s', (_label, text) => {
    const out = redact(text).text;
    expect(containsRawIdentifier(out)).toBe(false);
    expect(out).not.toBe(text);
  });

  it.each([
    'AED 150 000 000',
    'AED 150000000',
    '150,000,000 AED',
    'turnover 4,200,000 dirhams',
    'meeting on 27/09/2026 at 10',
    'meeting on 27/09/2026 10',
    'AED 1,500,000,000',
    'founded 2019-03-01',
  ])('leaves an amount or a date alone: %s', (text) => {
    expect(redact(text).text).toBe(normaliseDigits(text));
    expect(containsRawIdentifier(text)).toBe(false);
  });

  it('folds every decimal digit script to ASCII', () => {
    expect(normaliseDigits('٠١٢ ۳۴۵ ६७८ ９')).toBe('012 345 678 9');
  });
});

describe('language detection (TS-INT-6)', () => {
  it.each([
    ['मुझे business account खोलना है', 'other'],
    ['Хочу открыть счёт', 'other'],
    ['我想开户', 'other'],
    ['എനിക്ക് അക്കൗണ്ട് വേണം', 'other'],
    ['👍', 'unknown'],
    ['I want an account', 'en'],
    ['أريد فتح حساب', 'ar'],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it('keeps uncalibrated scripts in shadow by default', () => {
    expect(loadConfig({}).shadowLanguages).toContain('other');
  });
});

describe('configuration (SDK-4, TS-INT-9, HOST-8, SEC-5)', () => {
  it('treats a blank value as unset', () => {
    expect(
      loadConfig({ TYPESAFE_MODEL: '', TS_GUARDRAIL_FAIL_MODE: ' ' })
    ).toMatchObject({ model: 'jev-1.13.0', guardrailFailMode: 'hold' });
  });

  it.each(['jev-1.13', 'jev', 'JEV-LATEST', 'jev-latest', 'jev-preview'])(
    'refuses a model that is not a pinned version: %s',
    (model) => {
      expect(() => loadConfig({ TYPESAFE_MODEL: model })).toThrow(/pinned/);
    }
  );

  it('bounds the per-attempt timeouts', () => {
    expect(() => loadConfig({ TS_TIMEOUT_MS: '600000' })).toThrow(/1 to 10000/);
    expect(loadConfig({ TS_TIMEOUT_MS: '4000' }).timeoutMs).toBe(4000);
  });

  it('requires a hash key with the API key; an account list is optional', () => {
    expect(loadConfig({ ...ON, TS_ACCOUNT_IDS: '' }).accounts).toBe('*');
    expect(() => loadConfig({ ...ON, TS_LOG_HASH_KEY: 'short' })).toThrow(
      /TS_LOG_HASH_KEY/
    );
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: 'k', TS_LOG_HASH_KEY: '' })
    ).toThrow(/TS_LOG_HASH_KEY/);
    expect(() => loadConfig({ ...ON, TS_ACCOUNT_IDS: 'not-an-id' })).toThrow(
      /not an account id/
    );
    expect(
      loadConfig({
        ...ON,
        TS_ACCOUNT_IDS: '11111111-1111-4111-8111-111111111111',
      }).accounts
    ).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('names the variable in a boolean error', () => {
    expect(() => loadConfig({ TS_SHADOW: 'true # keep on' })).toThrow(
      /TS_SHADOW/
    );
  });
});

describe('threshold bounds (JQ-8)', () => {
  it('bounds a Score threshold by that Score’s own levels', () => {
    const levels = TRIAGE_QUESTIONS.urgency.criteria.length;
    expect(levels).toBe(3);
    expect(() =>
      validateThresholds('triage', {
        ...DEFAULT_THRESHOLDS.triage,
        urgencyUrgentMin: 2.5,
      })
    ).toThrow(/urgencyUrgentMin/);
    expect(() =>
      validateThresholds('guardrail', {
        ...DEFAULT_THRESHOLDS.guardrail,
        severityBlock: GUARDRAIL_QUESTIONS.severity.criteria.length,
      })
    ).toThrow(/severityBlock/);
  });

  it('refuses inherited property names as threshold keys', () => {
    expect(() =>
      validateThresholds('eligibility', {
        choiceConfidenceMin: 0.6,
        toString: 1,
      })
    ).toThrow(/unknown threshold keys/);
  });
});

describe('response validation (TS-INT-8)', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited name %s as a choice',
    (choice) => {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(TRIAGE_QUESTIONS)) {
        answers[id] =
          q.type === 'noul'
            ? { type: 'noul', noul: 0.1 }
            : q.type === 'choice'
              ? { type: 'choice', choice, confidence: 0.9 }
              : { type: 'score', score: 0, confidence: 0.9 };
      }
      expect(
        validateAnswers(TRIAGE_QUESTIONS, {
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 10 },
        })
      ).toMatch(/choice not in options/);
    }
  );
});

describe('gateway fail-safes (SDK-2, SDK-3, SEC-3)', () => {
  const A1 = '11111111-1111-4111-8111-111111111111';
  const A2 = '22222222-2222-4222-8222-222222222222';

  it('clips long turns so a normal state stays inside the budget', async () => {
    const sim = makeSim();
    const { layer, alerts } = makeLayer({ sim });
    const huge = 'word '.repeat(MAX_REQUEST_CHARS);
    const d = await layer.triage({
      journeyStage: 'x',
      message: 'hi',
      recentTurns: Array.from({ length: 6 }, () => ({
        from: 'customer' as const,
        text: huge,
      })),
    });
    // each turn is clipped to 1,000 characters, so this still fits
    expect(sim.calls).toHaveLength(1);
    expect(d.errorCode).toBeNull();
    expect(alerts.map((a) => a.code)).not.toContain('TS_STATE_TOO_LARGE');
  });

  it('withholds an oversized state without calling, and holds the draft', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim, store: approvedDb().store });
    const d = await layer.guardrail({
      customerMessage: 'hi',
      botReply: 'Hello!',
      evidence: [],
      context: Array.from({ length: 20 }, () => 'context '.repeat(600)),
    });
    expect(sim.calls).toHaveLength(0);
    expect(d).toMatchObject({
      errorCode: 'STATE_TOO_LARGE',
      outcome: 'hold',
      act: true,
      rmTaskReason: 'GUARDRAIL_REVIEW',
    });
  });

  it('waits out a 429 Retry-After across every check, once', async () => {
    let n = 0;
    const sim = makeSim(() =>
      ++n === 1
        ? { status: 429, headers: { 'retry-after': '30' } }
        : { answers: {} }
    );
    const { layer } = makeLayer({ sim });
    const first = await layer.triage({ journeyStage: 'x', message: 'a' });
    expect(first.errorCode).toBe('RATE_LIMIT');
    const calls = sim.calls.length;
    const second = await layer.guardrail({
      customerMessage: 'a',
      botReply: 'b',
      evidence: [],
    });
    expect(second.errorCode).toBe('RATE_LIMIT');
    expect(sim.calls.length).toBe(calls); // not called while cooling down
  });

  it("one account's bad requests do not pause another account's checks", async () => {
    const sim = makeSim((body) =>
      (body.state as { message?: string }).message === 'bad'
        ? { status: 400 }
        : { answers: {} }
    );
    const { layer } = makeLayer({ sim, store: approvedDb().store });
    for (let i = 0; i < 6; i++)
      await layer.triage({ accountId: A1, journeyStage: 'x', message: 'bad' });
    const other = await layer.triage({
      accountId: A2,
      journeyStage: 'x',
      message: 'fine',
    });
    expect(other.errorCode).toBeNull();
    const same = await layer.triage({
      accountId: A1,
      journeyStage: 'x',
      message: 'fine',
    });
    expect(same.errorCode).toBe('BREAKER_OPEN');
  });
});

describe('guardrail figures and banks (TS-INT-4, TS-INT-5)', () => {
  it('reads space-grouped thousands after a currency word as one amount', () => {
    expect(extractFigures('AED 25 000')).toEqual(['AED25000']);
  });

  it('accepts an AED amount whose bare number the source states', () => {
    expect(
      unsupportedFigures('Minimum balance is AED 25,000.', [
        { text: 'Minimum balance: 25,000' },
      ])
    ).toEqual([]);
  });

  it('does not read "invest. Bank" as Invest Bank', () => {
    expect(detectBanks('Please invest. Bank statements are required.')).toEqual(
      []
    );
  });
});

describe('eligibility licence (JQ-7)', () => {
  it('re-asks when the conversation never mentions a licence', async () => {
    const sim = makeSim(() => ({ answers: { trade_licence: 'not_stated' } }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation: [{ from: 'customer', text: 'We trade in Dubai' }],
      sectors: { it: 'IT services' },
      currentYear: 2026,
    });
    expect(d.hasTradeLicence).toMatchObject({ value: null, reask: true });
  });

  it('records a stated missing licence as false', async () => {
    const sim = makeSim(() => ({ answers: { trade_licence: 'no_licence' } }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation: [{ from: 'customer', text: 'No licence yet' }],
      sectors: { it: 'IT services' },
      currentYear: 2026,
    });
    expect(d.hasTradeLicence).toMatchObject({ value: false, reask: false });
  });
});
