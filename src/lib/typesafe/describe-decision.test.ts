import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { TsActivityItem } from './admin-types';
import {
  describeCheck,
  describeDecision,
  describeLanguage,
  describeReason,
  describeReasons,
  formatLatency,
  formatUsd,
  GUARDRAIL_HAZARDS,
  KNOWN_REASON_CODES,
  parsePassagesDecision,
  PASSAGE_VERDICTS,
  type DecisionDescription,
} from './describe-decision';

function item(overrides: Partial<TsActivityItem>): TsActivityItem {
  return {
    id: 'row-1',
    createdAt: '2026-09-29T10:00:00.000Z',
    check: 'triage',
    decision: 'bot',
    reasonCodes: [],
    acted: true,
    intervened: false,
    fallbackUsed: false,
    language: 'en',
    latencyMs: 420,
    errorCode: null,
    conversationId: null,
    contactId: null,
    contactName: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------
// Outcome kind — the badge colour
// ------------------------------------------------------------------

describe('describeDecision: kind and effect', () => {
  it('an acted intervention is "intervened" and says it acted', () => {
    const d = describeDecision(item({ decision: 'rm', acted: true }));
    expect(d.kind).toBe('intervened');
    expect(d.effect).toBe('acted');
    expect(d.outcome.key).toBe('outcome.triage.rm.acted');
  });

  it('the same decision in monitor mode is "logged" and reads as conditional', () => {
    const d = describeDecision(item({ decision: 'rm', acted: false }));
    expect(d.kind).toBe('logged');
    expect(d.effect).toBe('logged');
    expect(d.outcome.key).toBe('outcome.triage.rm.logged');
  });

  it('a decision with nothing to change is "passed", acted or not', () => {
    for (const acted of [true, false]) {
      const bot = describeDecision(item({ decision: 'bot', acted }));
      expect(bot.kind).toBe('passed');
      expect(bot.effect).toBeNull();
      const send = describeDecision(
        item({ check: 'guardrail', decision: 'send', acted })
      );
      expect(send.kind).toBe('passed');
      expect(send.outcome.key).toBe('outcome.guardrail.send');
    }
  });

  it('a fallback is "unavailable" whatever the decision, and never "logged only"', () => {
    const held = describeDecision(
      item({
        check: 'guardrail',
        decision: 'hold',
        acted: true,
        fallbackUsed: true,
        reasonCodes: ['DEGRADED_HOLD', 'TS_UNAVAILABLE'],
      })
    );
    expect(held.kind).toBe('unavailable');
    expect(held.effect).toBeNull();
    // What happened is still said plainly: the reply WAS held.
    expect(held.outcome.key).toBe('outcome.guardrail.hold.acted');

    const topK = describeDecision(
      item({
        check: 'passages',
        decision: 'fallback_top_k',
        acted: false,
        fallbackUsed: true,
      })
    );
    expect(topK.kind).toBe('unavailable');
    expect(topK.effect).toBeNull();
  });

  it('host_default is "unavailable" even if fallbackUsed was not set', () => {
    const d = describeDecision(
      item({ decision: 'host_default', fallbackUsed: false, acted: false })
    );
    expect(d.kind).toBe('unavailable');
    expect(d.outcome.key).toBe('outcome.triage.hostDefault');
  });

  it('an unsent reply that TypeSafe could not check says so', () => {
    const d = describeDecision(
      item({
        check: 'guardrail',
        decision: 'send',
        fallbackUsed: true,
        reasonCodes: ['DEGRADED_SEND', 'TS_UNAVAILABLE'],
      })
    );
    expect(d.kind).toBe('unavailable');
    expect(d.outcome.key).toBe('outcome.guardrail.sendUnchecked');
  });
});

// ------------------------------------------------------------------
// Outcomes per check
// ------------------------------------------------------------------

describe('describeDecision: triage outcomes', () => {
  it.each([
    ['bot_restricted', 'outcome.triage.botRestricted'],
    ['rm', 'outcome.triage.rm'],
    ['opted_out', 'outcome.triage.optedOut'],
  ])('%s has acted and logged wordings', (decision, base) => {
    expect(describeDecision(item({ decision, acted: true })).outcome.key).toBe(
      `${base}.acted`
    );
    expect(describeDecision(item({ decision, acted: false })).outcome.key).toBe(
      `${base}.logged`
    );
  });
});

describe('describeDecision: guardrail outcomes', () => {
  it.each(['hold', 'block'])('%s is an intervention', (decision) => {
    const acted = describeDecision(
      item({ check: 'guardrail', decision, acted: true })
    );
    expect(acted.kind).toBe('intervened');
    expect(acted.outcome.key).toBe(`outcome.guardrail.${decision}.acted`);
    const logged = describeDecision(
      item({ check: 'guardrail', decision, acted: false })
    );
    expect(logged.kind).toBe('logged');
    expect(logged.outcome.key).toBe(`outcome.guardrail.${decision}.logged`);
  });
});

describe('describeDecision: passages outcomes', () => {
  it('keeping every excerpt passes, with the count', () => {
    const d = describeDecision(
      item({ check: 'passages', decision: 'include=4;conflict=0;drop=0' })
    );
    expect(d.kind).toBe('passed');
    expect(d.outcome).toMatchObject({
      key: 'outcome.passages.kept',
      params: { count: 4 },
    });
  });

  it('dropping excerpts is an intervention over the total', () => {
    const d = describeDecision(
      item({
        check: 'passages',
        decision: 'include=3;conflict=1;drop=2',
        acted: true,
      })
    );
    expect(d.kind).toBe('intervened');
    expect(d.outcome).toMatchObject({
      key: 'outcome.passages.removed.acted',
      params: { drop: 2, conflict: 1, total: 6 },
    });
  });

  it('conflicts alone are an intervention of their own', () => {
    const d = describeDecision(
      item({
        check: 'passages',
        decision: 'include=2;conflict=1;drop=0',
        acted: false,
      })
    );
    expect(d.kind).toBe('logged');
    expect(d.outcome).toMatchObject({
      key: 'outcome.passages.conflicting.logged',
      params: { conflict: 1, total: 3 },
    });
  });
});

describe('describeDecision: eligibility outcomes', () => {
  it('reads complete, partial and the fallback', () => {
    expect(
      describeDecision(item({ check: 'eligibility', decision: 'complete' }))
    ).toMatchObject({
      kind: 'passed',
      outcome: { key: 'outcome.eligibility.complete' },
    });
    expect(
      describeDecision(
        item({ check: 'eligibility', decision: 'partial:4/6', acted: true })
      )
    ).toMatchObject({
      kind: 'intervened',
      outcome: {
        key: 'outcome.eligibility.partial',
        params: { captured: 4, total: 6 },
      },
    });
    expect(
      describeDecision(
        item({
          check: 'eligibility',
          decision: 'reask_all',
          reasonCodes: ['FALLBACK'],
        })
      ).kind
    ).toBe('unavailable');
  });
});

// ------------------------------------------------------------------
// Robustness: the log can carry strings this file has never seen
// ------------------------------------------------------------------

describe('describeDecision: unknown input never throws', () => {
  it('shows an unknown decision raw and reports whether it acted', () => {
    const acted = describeDecision(
      item({ decision: 'escalate_v2', acted: true })
    );
    expect(acted.outcome).toEqual({
      key: null,
      params: {},
      raw: 'escalate_v2',
    });
    expect(acted.kind).toBe('intervened');
    expect(
      describeDecision(item({ decision: 'escalate_v2', acted: false })).kind
    ).toBe('logged');
  });

  it('shows an unknown check raw', () => {
    const d = describeDecision(
      item({ check: 'sentiment' as TsActivityItem['check'], decision: 'x' })
    );
    expect(d.check).toEqual({ key: null, params: {}, raw: 'sentiment' });
    expect(d.outcome.key).toBeNull();
  });

  it('treats a malformed passages decision as unknown, not as zero excerpts', () => {
    for (const decision of [
      'include=a;drop=1',
      'include=1',
      '',
      'drop=1;x=2',
    ]) {
      const d = describeDecision(item({ check: 'passages', decision }));
      expect(d.outcome.key).toBeNull();
      expect(d.outcome.raw).toBe(decision);
    }
  });

  it('survives missing or junk reason codes and a null language', () => {
    const d = describeDecision(
      item({
        reasonCodes: null as unknown as string[],
        language: null,
      })
    );
    expect(d.reasons).toEqual([]);
    expect(d.language).toBeNull();

    const junk = describeDecision(
      item({
        reasonCodes: [42, '', 'HUMAN_REQUEST', null] as unknown as string[],
      })
    );
    expect(junk.reasons.map((r) => r.raw)).toEqual(['HUMAN_REQUEST']);
  });

  it('survives a non-string decision', () => {
    const d = describeDecision(
      item({ decision: undefined as unknown as string })
    );
    expect(d.outcome.key).toBeNull();
  });
});

// ------------------------------------------------------------------
// Reasons
// ------------------------------------------------------------------

describe('describeReason', () => {
  it.each([
    'OPT_OUT_RECORD',
    'OPT_OUT_REVIEW',
    'OPT_OUT_WITH_HUMAN_REQUEST',
    'OPT_OUT_WITH_COMPLAINT',
    'HUMAN_REQUEST',
    'COMPLAINT',
    'TRIAGE_UNCERTAIN',
    'INSTRUCTS_ASSISTANT',
    'NON_PARTNER_BANK',
    'NON_PARTNER_BANK_MENTION',
    'DISSATISFIED',
    'LEAD_HOT_CALLBACK',
    'FALLBACK',
    'SEVERITY_UPGRADE',
    'CODE_NON_PARTNER_BANK',
    'CODE_NON_PARTNER_BANK_ECHO',
    'CODE_UNSUPPORTED_FIGURE',
    'DEGRADED_HOLD',
    'DEGRADED_SEND',
    'TS_UNAVAILABLE',
    'POLICY_UNAVAILABLE',
    'LANGUAGE_SHADOW_CODE_ONLY',
    'LANGUAGE_SHADOW_MODEL_REVIEW',
  ])('humanises %s', (code) => {
    expect(describeReason(code)).toEqual({
      key: `reasons.${code}`,
      params: {},
      raw: code,
    });
  });

  it('humanises every hazard at both actions', () => {
    for (const hazard of GUARDRAIL_HAZARDS) {
      for (const action of ['BLOCK', 'REVIEW']) {
        const code = `${hazard}_${action}`;
        expect(describeReason(code).key).toBe(`reasons.${code}`);
      }
    }
  });

  it('keeps triage NON_PARTNER_BANK apart from the guardrail hazard', () => {
    expect(describeReason('NON_PARTNER_BANK').key).toBe(
      'reasons.NON_PARTNER_BANK'
    );
    expect(describeReason('NON_PARTNER_BANK_BLOCK').key).toBe(
      'reasons.NON_PARTNER_BANK_BLOCK'
    );
  });

  it('humanises eligibility re-asks it knows, and leaves others raw', () => {
    expect(describeReason('REASK_emirate').key).toBe('reasons.reask.emirate');
    expect(describeReason('REASK_shoeSize')).toEqual({
      key: null,
      params: {},
      raw: 'REASK_shoeSize',
    });
  });

  it('falls back to the raw code for anything unknown', () => {
    for (const code of ['NEW_THING', 'PROMISES_APPROVAL_MAYBE', 'reasons.x']) {
      expect(describeReason(code)).toEqual({
        key: null,
        params: {},
        raw: code,
      });
    }
  });
});

describe('describeReasons', () => {
  it('keeps logged order and folds duplicates', () => {
    const r = describeReasons('triage', [
      'OPT_OUT_RECORD',
      'OPT_OUT_WITH_COMPLAINT',
      'OPT_OUT_RECORD',
    ]);
    expect(r.map((x) => [x.raw, x.count])).toEqual([
      ['OPT_OUT_RECORD', 2],
      ['OPT_OUT_WITH_COMPLAINT', 1],
    ]);
  });

  it('summarises passages by verdict and never shows a chunk id', () => {
    const r = describeReasons('passages', [
      'c1:EVIDENCE',
      'c2:NOT_RELEVANT',
      'c3:INJECTION',
      'c4:NOT_RELEVANT',
      'c5:CONTRADICTS_PREMISE',
      '3f2c:9a:NO_EVIDENCE',
    ]);
    expect(r).toEqual([
      {
        key: 'reasons.passage.INJECTION',
        params: { count: 1 },
        raw: 'INJECTION',
        count: 1,
      },
      {
        key: 'reasons.passage.CONTRADICTS_PREMISE',
        params: { count: 1 },
        raw: 'CONTRADICTS_PREMISE',
        count: 1,
      },
      {
        key: 'reasons.passage.NOT_RELEVANT',
        params: { count: 2 },
        raw: 'NOT_RELEVANT',
        count: 2,
      },
      {
        key: 'reasons.passage.NO_EVIDENCE',
        params: { count: 1 },
        raw: 'NO_EVIDENCE',
        count: 1,
      },
    ]);
    for (const reason of r) expect(reason.raw).not.toMatch(/c\d|3f2c/);
  });

  it('reads the passages fallback marker as a count of failures', () => {
    const r = describeReasons('passages', ['c1:EVIDENCE', 'FALLBACK:2_FAILED']);
    expect(r).toEqual([
      {
        key: 'reasons.passage.FALLBACK',
        params: { count: 2 },
        raw: 'FALLBACK:2_FAILED',
        count: 1,
      },
    ]);
  });

  it('counts an unknown passage verdict under its raw name', () => {
    const r = describeReasons('passages', ['c1:OFF_BRAND', 'c2:OFF_BRAND']);
    expect(r).toEqual([{ key: null, params: {}, raw: 'OFF_BRAND', count: 2 }]);
  });
});

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

describe('parsePassagesDecision', () => {
  it('parses the logged summary', () => {
    expect(parsePassagesDecision('include=3;conflict=1;drop=2')).toEqual({
      include: 3,
      conflict: 1,
      drop: 2,
    });
    expect(parsePassagesDecision('include=3;drop=0')).toEqual({
      include: 3,
      conflict: 0,
      drop: 0,
    });
  });

  it('rejects anything else', () => {
    expect(parsePassagesDecision('fallback_top_k')).toBeNull();
    expect(parsePassagesDecision('include=-1;drop=0')).toBeNull();
  });
});

describe('describeCheck / describeLanguage', () => {
  it('names known checks and languages', () => {
    expect(describeCheck('guardrail').key).toBe('checks.guardrail');
    expect(describeCheck('eligibility').key).toBe('checks.eligibility');
    expect(describeLanguage('ar')?.key).toBe('languages.ar');
    expect(describeLanguage('fr')).toEqual({
      key: null,
      params: {},
      raw: 'fr',
    });
    expect(describeLanguage(undefined)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('keeps fractions of a cent visible', () => {
    expect(formatUsd(0.0012, 'en-US')).toBe('$0.0012');
    expect(formatUsd(0.01234, 'en-US')).toBe('$0.0123');
    expect(formatUsd(0.5, 'en-US')).toBe('$0.50');
    expect(formatUsd(12.3, 'en-US')).toBe('$12.30');
    expect(formatUsd(0, 'en-US')).toBe('$0.00');
  });

  it('never rounds real spend down to zero, and tolerates junk', () => {
    expect(formatUsd(0.00001, 'en-US')).toBe('< $0.0001');
    expect(formatUsd(Number.NaN, 'en-US')).toBe('$0.00');
    expect(formatUsd(-3, 'en-US')).toBe('$0.00');
  });
});

describe('formatLatency', () => {
  it('uses ms below a second and s above', () => {
    expect(formatLatency(840.4)).toBe('840 ms');
    expect(formatLatency(1234)).toBe('1.2 s');
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(Number.NaN)).toBeNull();
  });
});

// ------------------------------------------------------------------
// Catalogue coverage: every key this file can emit must exist, in
// every locale, or the panel shows a keypath instead of a sentence.
// ------------------------------------------------------------------

const LOCALES = ['en', 'ko'];

function catalogue(locale: string): Record<string, unknown> {
  const raw = readFileSync(
    join(process.cwd(), 'messages', `${locale}.json`),
    'utf8'
  );
  return JSON.parse(raw).Settings.aiSafety;
}

function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      tree
    );
}

function emittedKeys(): string[] {
  const keys = new Set<string>();
  const add = (d: DecisionDescription) => {
    for (const label of [d.check, d.outcome, d.language, ...d.reasons]) {
      if (label?.key) keys.add(label.key);
    }
  };
  const decisions: [string, string][] = [
    ['triage', 'bot'],
    ['triage', 'bot_restricted'],
    ['triage', 'rm'],
    ['triage', 'opted_out'],
    ['triage', 'host_default'],
    ['guardrail', 'send'],
    ['guardrail', 'hold'],
    ['guardrail', 'block'],
    ['passages', 'include=2;conflict=0;drop=0'],
    ['passages', 'include=2;conflict=0;drop=1'],
    ['passages', 'include=2;conflict=1;drop=0'],
    ['passages', 'fallback_top_k'],
    ['eligibility', 'complete'],
    ['eligibility', 'partial:3/6'],
    ['eligibility', 'reask_all'],
  ];
  for (const [check, decision] of decisions) {
    for (const acted of [true, false]) {
      for (const fallbackUsed of [true, false]) {
        add(
          describeDecision(
            item({
              check: check as TsActivityItem['check'],
              decision,
              acted,
              fallbackUsed,
            })
          )
        );
      }
    }
  }
  for (const code of KNOWN_REASON_CODES) keys.add(`reasons.${code}`);
  for (const verdict of PASSAGE_VERDICTS)
    keys.add(`reasons.passage.${verdict}`);
  keys.add('reasons.passage.FALLBACK');
  for (const field of [
    'emirate',
    'legalForm',
    'sector',
    'turnover',
    'yearsInBusiness',
    'hasTradeLicence',
  ]) {
    const key = describeReason(`REASK_${field}`).key;
    if (key) keys.add(key);
  }
  for (const lang of ['en', 'ar', 'mixed', 'other', 'unknown']) {
    const key = describeLanguage(lang)?.key;
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

describe('catalogue coverage', () => {
  const keys = emittedKeys();

  it('emits a meaningful set of keys (guards the guard)', () => {
    expect(keys.length).toBeGreaterThan(60);
  });

  it.each(LOCALES)('%s.json has a string for every emitted key', (locale) => {
    const tree = catalogue(locale);
    const missing = keys.filter((k) => typeof lookup(tree, k) !== 'string');
    expect(missing, `Settings.aiSafety keys missing in ${locale}.json`).toEqual(
      []
    );
  });
});

describe('watch rows (conversations people handle)', () => {
  const watch = (decision: string, acted: boolean, codes: string[] = []) =>
    describeDecision(
      item({ decision, acted, reasonCodes: ['WATCH', ...codes] })
    );

  it('an opt-out it tagged reads as recorded and acted', () => {
    const d = watch('opted_out', true, ['OPT_OUT_RECORD']);
    expect(d.kind).toBe('intervened');
    expect(d.outcome.key).toBe('outcome.triage.optedOut.acted');
  });

  it('an opt-out in monitor mode reads as logged only', () => {
    const d = watch('opted_out', false, ['OPT_OUT_RECORD']);
    expect(d.kind).toBe('logged');
    expect(d.outcome.key).toBe('outcome.triage.optedOut.logged');
  });

  it('never claims the bot answered', () => {
    const d = watch('bot', false);
    expect(d.kind).toBe('passed');
    expect(d.outcome.key).toBe('outcome.triage.watched');
  });

  it('a request for a person is noted, not "would hand to a person"', () => {
    const d = watch('rm', false, ['HUMAN_REQUEST']);
    expect(d.kind).toBe('passed');
    expect(d.outcome.key).toBe('outcome.triage.watchedFlagged');
    expect(d.reasons.map((r) => r.key)).toEqual([
      'reasons.WATCH',
      'reasons.HUMAN_REQUEST',
    ]);
  });
});
