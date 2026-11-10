import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import {
  describeRule,
  draftBody,
  draftFromRule,
  emptyDraft,
  newDraftAction,
  parseRuleRuns,
  parseRules,
  parseSavedRule,
  ruleErrorKey,
  summariseRun,
  toggleBody,
  validateDraft,
  RULE_TRIGGERS,
  type RuleDraft,
  type RulesT,
  type RuleView,
} from './rules-ui';

const U1 = '11111111-1111-4111-8111-111111111111';

const catalogue = (locale: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')
  );

function translator(locale = 'en'): { t: RulesT; errors: string[] } {
  const errors: string[] = [];
  const tr = createTranslator({
    locale,
    messages: catalogue(locale),
    namespace: 'CaseRules',
    onError: (e) => errors.push(e.message),
  });
  return { t: tr as unknown as RulesT, errors };
}

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  ruleId: 'r1',
  name: 'Note',
  enabled: true,
  trigger: 'case_opened',
  conditions: {},
  actions: [{ kind: 'add_note', body: 'Hi {{customer}}' }],
  position: 0,
  ...over,
});

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  ...emptyDraft(),
  name: 'Rule',
  actions: [{ ...newDraftAction('add_note'), body: 'x' }],
  ...over,
});

describe('parsing', () => {
  it('reads rules in position order and keeps only known action shapes', () => {
    const rules = parseRules({
      rules: [
        {
          ruleId: 'b',
          name: 'B',
          enabled: true,
          trigger: 'no_activity',
          conditions: { days: 3, bank_code: 'ADCB', junk: 1 },
          actions: [
            { kind: 'assign_agent', userId: U1 },
            { kind: 'set_priority', priority: 'urgent' },
            { kind: 'set_priority', priority: 'mega' },
            { kind: 'add_task' },
          ],
          position: 2,
        },
        { ruleId: 'a', name: 'A', enabled: false, position: 1 },
        { name: 'no id' },
        'junk',
      ],
    });
    expect(rules?.map((r) => r.ruleId)).toEqual(['a', 'b']);
    expect(rules?.[1].conditions).toEqual({ days: 3, bank_code: 'ADCB' });
    expect(rules?.[1].actions).toEqual([
      { kind: 'assign_agent', userId: U1 },
      { kind: 'set_priority', priority: 'urgent' },
    ]);
    expect(rules?.[0].enabled).toBe(false);
  });

  it('answers null for an unreadable body', () => {
    expect(parseRules(null)).toBeNull();
    expect(parseRules({ rules: 'x' })).toBeNull();
    expect(parseSavedRule({})).toBeNull();
    expect(parseRuleRuns({ nope: [] })).toBeNull();
  });

  it('maps a refusal body to its error key', () => {
    expect(ruleErrorKey({ error: 'x', code: 'RULE_INVALID' })).toBe(
      'RULE_INVALID'
    );
    expect(ruleErrorKey({ code: 'NOT_ALLOWED' })).toBe('NOT_ALLOWED');
    expect(ruleErrorKey({ code: 'RULE_NOT_FOUND' })).toBe('RULE_NOT_FOUND');
    expect(ruleErrorKey({ code: 'SOMETHING' })).toBe('generic');
    expect(ruleErrorKey(null)).toBe('generic');
  });

  it('reads a saved rule', () => {
    expect(
      parseSavedRule({ rule: { ruleId: 'r', name: 'N', trigger: 'x' } })?.ruleId
    ).toBe('r');
  });

  it('reads runs and their applied actions', () => {
    const runs = parseRuleRuns({
      items: [
        {
          ruleId: 'r1',
          trigger: 'case_opened',
          matched: true,
          applied: [
            { kind: 'add_note', ok: true, refusal: null },
            { kind: 'assign_agent', ok: false, refusal: 'MANAGED_EXTERNALLY' },
            'junk',
          ],
          at: '2026-11-10T08:00:00.000Z',
        },
        { ruleId: 'r2' },
      ],
    });
    expect(runs).toHaveLength(1);
    expect(runs?.[0].applied).toEqual([
      { kind: 'add_note', ok: true, refusal: null },
      { kind: 'assign_agent', ok: false, refusal: 'MANAGED_EXTERNALLY' },
    ]);
  });
});

describe('validateDraft', () => {
  it('accepts a minimal draft', () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it('needs a name of 1..60 characters', () => {
    expect(validateDraft(draft({ name: ' \t' }))).toEqual(['name_required']);
    expect(validateDraft(draft({ name: 'x'.repeat(61) }))).toEqual([
      'name_too_long',
    ]);
    expect(validateDraft(draft({ name: ` ${'x'.repeat(60)} ` }))).toEqual([]);
  });

  it('needs a known trigger', () => {
    expect(
      validateDraft(draft({ trigger: 'nope' as RuleDraft['trigger'] }))
    ).toEqual(['trigger_invalid']);
  });

  it('needs days of 1..365 on no_activity only', () => {
    const na = (days: string) =>
      validateDraft(draft({ trigger: 'no_activity', days }));
    expect(na('')).toEqual(['days_required']);
    expect(na('0')).toEqual(['days_invalid']);
    expect(na('366')).toEqual(['days_invalid']);
    expect(na('1.5')).toEqual(['days_invalid']);
    expect(na('-2')).toEqual(['days_invalid']);
    expect(na('1')).toEqual([]);
    expect(na('365')).toEqual([]);
    // Any other trigger ignores the field, and the body leaves it out.
    const d = draft({ trigger: 'stage_changed', days: '0' });
    expect(validateDraft(d)).toEqual([]);
    expect(draftBody(d)?.conditions).toEqual({});
    expect(
      draftBody(draft({ trigger: 'no_activity', days: ' 14 ' }))?.conditions
    ).toEqual({ days: 14 });
  });

  it('limits text conditions to 200 characters', () => {
    expect(validateDraft(draft({ product: 'p'.repeat(201) }))).toEqual([
      'condition_too_long',
    ]);
  });

  it('needs amounts of 0 or more, lowest not above highest', () => {
    expect(validateDraft(draft({ amountMin: '-1' }))).toEqual([
      'amount_invalid',
    ]);
    expect(validateDraft(draft({ amountMax: '1e16' }))).toEqual([
      'amount_invalid',
    ]);
    expect(validateDraft(draft({ amountMax: '9999999999' }))).toEqual([]);
    expect(validateDraft(draft({ amountMax: 'abc' }))).toEqual([
      'amount_invalid',
    ]);
    expect(validateDraft(draft({ amountMin: '10', amountMax: '5' }))).toEqual([
      'amount_range',
    ]);
    expect(validateDraft(draft({ amountMin: '5', amountMax: '5' }))).toEqual(
      []
    );
  });

  it('needs 1..5 actions', () => {
    expect(validateDraft(draft({ actions: [] }))).toEqual(['actions_none']);
    const six = Array.from({ length: 6 }, () => ({
      ...newDraftAction('add_note'),
      body: 'x',
    }));
    expect(validateDraft(draft({ actions: six }))).toEqual([
      'actions_too_many',
    ]);
  });

  it("checks each action's own field", () => {
    const one = (a: Partial<ReturnType<typeof newDraftAction>>) =>
      validateDraft(draft({ actions: [{ ...newDraftAction(), ...a }] }));
    expect(one({ kind: 'assign_agent' })).toEqual(['person_required']);
    expect(one({ kind: 'assign_coordinator', userId: ' ' })).toEqual([
      'person_required',
    ]);
    expect(one({ kind: 'assign_agent', userId: U1 })).toEqual([]);
    expect(one({ kind: 'add_note', body: '  ' })).toEqual(['note_required']);
    expect(one({ kind: 'add_note', body: 'x'.repeat(4001) })).toEqual([
      'note_too_long',
    ]);
    expect(one({ kind: 'set_priority', priority: 'mega' as 'low' })).toEqual([
      'priority_invalid',
    ]);
    expect(one({ kind: 'set_priority', priority: 'high' })).toEqual([]);
  });
});

describe('draftBody', () => {
  it('is null for an invalid draft', () => {
    expect(draftBody(draft({ name: '' }))).toBeNull();
  });

  it('sends only the filled conditions and each action in its own shape', () => {
    const body = draftBody(
      draft({
        name: '  Big ADCB  ',
        bankCode: 'ADCB',
        stage: ' ',
        product: ' Personal loan ',
        amountMin: '0',
        amountMax: '',
        preSubmission: 'no',
        actions: [
          {
            ...newDraftAction('assign_coordinator'),
            userId: U1,
            body: 'stale',
          },
          { ...newDraftAction('add_note'), body: 'Hi {{customer}}' },
          { ...newDraftAction('set_priority'), priority: 'urgent' },
        ],
      })
    );
    expect(body).toEqual({
      name: 'Big ADCB',
      enabled: true,
      trigger: 'case_opened',
      conditions: {
        bank_code: 'ADCB',
        product: 'Personal loan',
        amount_min: 0,
        pre_submission: false,
      },
      actions: [
        { kind: 'assign_coordinator', userId: U1 },
        { kind: 'add_note', body: 'Hi {{customer}}' },
        { kind: 'set_priority', priority: 'urgent' },
      ],
    });
  });

  it('round-trips a saved rule through the editor', () => {
    const r = rule({
      trigger: 'no_activity',
      conditions: { days: 7, stage: 'Submitted', pre_submission: true },
      actions: [
        { kind: 'assign_agent', userId: U1 },
        { kind: 'set_priority', priority: 'high' },
      ],
      position: 3,
    });
    expect(draftBody(draftFromRule(r))).toEqual({
      ruleId: 'r1',
      name: 'Note',
      enabled: true,
      trigger: 'no_activity',
      conditions: { days: 7, stage: 'Submitted', pre_submission: true },
      actions: r.actions,
      position: 3,
    });
  });

  it('flips only enabled for the toggle', () => {
    expect(toggleBody(rule(), false)).toEqual({
      ruleId: 'r1',
      name: 'Note',
      enabled: false,
      trigger: 'case_opened',
      conditions: {},
      actions: [{ kind: 'add_note', body: 'Hi {{customer}}' }],
      position: 0,
    });
  });
});

describe('describeRule', () => {
  const ctx = (t: RulesT, locale = 'en') => ({
    t,
    locale,
    bankName: (c: string) => (c === 'ADCB' ? 'ADCB Bank' : c),
    personName: (id: string) => (id === U1 ? 'Sara' : 'someone'),
  });

  it('words the example sentence', () => {
    const { t, errors } = translator();
    expect(
      describeRule(rule({ conditions: { bank_code: 'ADCB' } }), ctx(t))
    ).toBe('When a case is opened at ADCB Bank, add a note');
    expect(errors).toEqual([]);
  });

  it('words every trigger', () => {
    const { t, errors } = translator();
    const words = (trigger: string, days?: number) =>
      describeRule(rule({ trigger, conditions: days ? { days } : {} }), ctx(t));
    expect(words('case_opened')).toBe('When a case is opened, add a note');
    expect(words('stage_changed')).toBe(
      "When a case's stage changes, add a note"
    );
    expect(words('sla_overdue')).toBe(
      "When a case's SLA timer is overdue, add a note"
    );
    expect(words('no_activity', 1)).toBe(
      'When a case has no activity for 1 day, add a note'
    );
    expect(words('no_activity', 14)).toBe(
      'When a case has no activity for 14 days, add a note'
    );
    expect(words('submission_attached')).toBe(
      'When a submission is attached to a case, add a note'
    );
    expect(words('future_trigger')).toBe('When something happens, add a note');
    expect(errors).toEqual([]);
  });

  it('words every action and condition', () => {
    const { t, errors } = translator();
    expect(
      describeRule(
        rule({
          trigger: 'stage_changed',
          conditions: {
            stage: 'Submitted',
            product: 'Card',
            amount_min: 1000,
            amount_max: 5000,
            pre_submission: false,
          },
          actions: [
            { kind: 'assign_agent', userId: U1 },
            { kind: 'assign_coordinator', userId: U1 },
            { kind: 'set_priority', priority: 'urgent' },
            { kind: 'add_note', body: 'x' },
          ],
        }),
        ctx(t)
      )
    ).toBe(
      "When a case's stage changes in Submitted for Card of at least AED 1000 of at most AED 5000 after submission, assign Sara as agent, assign Sara as coordinator, set the priority to Urgent, and add a note"
    );
    expect(
      describeRule(
        rule({ conditions: { pre_submission: true }, actions: [] }),
        ctx(t)
      )
    ).toBe('When a case is opened before submission, do nothing');
    expect(errors).toEqual([]);
  });

  it('renders in Korean without errors', () => {
    const { t, errors } = translator('ko');
    for (const trigger of RULE_TRIGGERS)
      expect(
        describeRule(
          rule({
            trigger,
            conditions: { days: 2, bank_code: 'ADCB' },
            actions: [
              { kind: 'assign_agent', userId: U1 },
              { kind: 'set_priority', priority: 'low' },
            ],
          }),
          ctx(t, 'ko')
        )
      ).not.toBe('');
    expect(errors).toEqual([]);
  });
});

describe('summariseRun', () => {
  const run = (over: Partial<Parameters<typeof summariseRun>[0]> = {}) => ({
    ruleId: 'r1',
    trigger: 'case_opened',
    matched: true,
    applied: [],
    at: '2026-11-10T08:00:00.000Z',
    ...over,
  });

  it('words matched, stopped and not matched', () => {
    const { t, errors } = translator();
    expect(summariseRun(run({ matched: false }), t)).toBe('Not matched');
    expect(
      summariseRun(
        run({ applied: [{ kind: 'add_note', ok: true, refusal: null }] }),
        t
      )
    ).toBe('Matched · note added');
    expect(
      summariseRun(
        run({
          applied: [
            { kind: 'add_note', ok: false, refusal: 'MANAGED_EXTERNALLY' },
          ],
        }),
        t
      )
    ).toBe('Matched · stopped: Managed in Compass');
    expect(
      summariseRun(
        run({
          applied: [
            { kind: 'assign_agent', ok: true, refusal: null },
            { kind: 'set_priority', ok: true, refusal: null },
            {
              kind: 'assign_coordinator',
              ok: false,
              refusal: 'ASSIGNEE_INVALID',
            },
            { kind: 'add_note', ok: true, refusal: null },
          ],
        }),
        t
      )
    ).toBe(
      "Matched · agent assigned · priority set · stopped: That person can't take cases"
    );
    expect(
      summariseRun(
        run({ applied: [{ kind: 'add_note', ok: false, refusal: '23514' }] }),
        t
      )
    ).toBe('Matched · stopped: Refused');
    expect(
      summariseRun(
        run({ applied: [{ kind: 'mystery', ok: true, refusal: null }] }),
        t
      )
    ).toBe('Matched · done');
    expect(summariseRun(run(), t)).toBe('Matched');
    expect(errors).toEqual([]);
  });
});
