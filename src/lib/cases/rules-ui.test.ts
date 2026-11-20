import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import {
  actionKindsFor,
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
  templateChoices,
  toggleBody,
  validateDraft,
  withTrigger,
  RULE_TRIGGERS,
  type DraftAction,
  type RuleDraft,
  type RuleRunView,
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

// ---------- 214: stage_entered / last_required_doc_received ----------

// The catalogue is another job's; a key-echoing translator pins the logic.
const echo: RulesT = (key, values) =>
  values && Object.keys(values).length > 0
    ? `${key}{${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}}`
    : key;

const task = (over: Record<string, unknown> = {}) => ({
  kind: 'create_task' as const,
  templateKey: 'chase_docs',
  ownerRole: 'agent' as const,
  ...over,
});

describe('214 rule editor logic', () => {
  it('parses a saved rule with each new action', () => {
    const json = {
      ruleId: 'r9',
      name: 'N',
      enabled: true,
      trigger: 'stage_entered',
      conditions: { stage: 'Docs' },
      actions: [
        { kind: 'create_task', templateKey: 'a', ownerRole: 'coordinator' },
        {
          kind: 'create_task',
          templateKey: 'b',
          ownerRole: 'agent',
          dueHours: 24,
        },
        { kind: 'start_sla', timer: 'bank_response' },
        { kind: 'advance_stage' },
        { kind: 'start_sla', timer: 'nope' },
        { kind: 'create_task', templateKey: 'c', ownerRole: 'nobody' },
      ],
      position: 1,
    };
    const r = parseSavedRule({ rule: json });
    expect(r?.actions).toEqual([
      { kind: 'create_task', templateKey: 'a', ownerRole: 'coordinator' },
      {
        kind: 'create_task',
        templateKey: 'b',
        ownerRole: 'agent',
        dueHours: 24,
      },
      { kind: 'start_sla', timer: 'bank_response' },
      { kind: 'advance_stage' },
    ]);
  });

  it('parses each new trigger and keeps it in RULE_TRIGGERS', () => {
    expect(RULE_TRIGGERS).toContain('stage_entered');
    expect(RULE_TRIGGERS).toContain('last_required_doc_received');
    for (const trigger of ['stage_entered', 'last_required_doc_received']) {
      const r = parseSavedRule({
        rule: {
          ruleId: 'r',
          name: 'N',
          enabled: true,
          trigger,
          conditions: {},
          actions: [],
          position: 0,
        },
      });
      expect(r?.trigger).toBe(trigger);
    }
  });

  it('actionKindsFor pairs actions with triggers', () => {
    expect(actionKindsFor('stage_entered')).toEqual([
      'assign_agent',
      'assign_coordinator',
      'add_note',
      'set_priority',
      'create_task',
      'start_sla',
    ]);
    expect(actionKindsFor('last_required_doc_received')).toEqual([
      'advance_stage',
    ]);
    for (const t of [
      'case_opened',
      'stage_changed',
      'sla_overdue',
      'no_activity',
      'submission_attached',
    ] as const) {
      const kinds = actionKindsFor(t);
      expect(kinds).not.toContain('create_task');
      expect(kinds).not.toContain('start_sla');
      expect(kinds).not.toContain('advance_stage');
    }
  });

  it('withTrigger leaves one advance_stage on the auto-advance trigger', () => {
    const d = withTrigger(
      draft({
        actions: [newDraftAction('add_note'), newDraftAction('add_note')],
      }),
      'last_required_doc_received'
    );
    expect(d.trigger).toBe('last_required_doc_received');
    expect(d.actions.map((a) => a.kind)).toEqual(['advance_stage']);
  });

  it('withTrigger drops actions the new trigger refuses', () => {
    const d = withTrigger(
      draft({
        trigger: 'stage_entered',
        actions: [
          { ...newDraftAction('add_note'), body: 'x' },
          newDraftAction('create_task'),
          newDraftAction('start_sla'),
        ],
      }),
      'case_opened'
    );
    expect(d.actions.map((a) => a.kind)).toEqual(['add_note']);
    const away = withTrigger(
      draft({ actions: [newDraftAction('advance_stage')] }),
      'case_opened'
    );
    expect(away.actions.map((a) => a.kind)).toEqual(['add_note']);
    const stays = withTrigger(
      draft({
        trigger: 'stage_entered',
        actions: [newDraftAction('create_task')],
      }),
      'stage_entered'
    );
    expect(stays.actions.map((a) => a.kind)).toEqual(['create_task']);
  });

  it('validateDraft reports each new problem', () => {
    const stage = draft({ trigger: 'stage_entered' });
    expect(validateDraft(stage)).toContain('stage_required');
    expect(validateDraft({ ...stage, stage: 'Docs' })).not.toContain(
      'stage_required'
    );

    expect(
      validateDraft(draft({ actions: [newDraftAction('advance_stage')] }))
    ).toContain('action_not_allowed');
    expect(
      validateDraft(
        draft({
          trigger: 'last_required_doc_received',
          actions: [{ ...newDraftAction('add_note'), body: 'x' }],
        })
      )
    ).toContain('action_not_allowed');

    const mk = (a: Partial<DraftAction>) =>
      draft({
        trigger: 'stage_entered',
        stage: 'Docs',
        actions: [{ ...newDraftAction('create_task'), templateKey: 'k', ...a }],
      });
    expect(validateDraft(mk({ templateKey: '' }))).toContain(
      'template_required'
    );
    expect(validateDraft(mk({ templateKey: 'Bad Key' }))).toContain(
      'template_required'
    );
    expect(
      validateDraft(mk({ ownerRole: 'admin' as unknown as 'agent' }))
    ).toContain('owner_invalid');
    for (const dueHours of ['0', '8761', '1.5']) {
      expect(validateDraft(mk({ dueHours }))).toContain('due_hours_invalid');
    }
    for (const dueHours of ['', '1', '8760']) {
      expect(validateDraft(mk({ dueHours }))).toEqual([]);
    }
    expect(
      validateDraft(
        draft({
          trigger: 'stage_entered',
          stage: 'Docs',
          actions: [
            {
              ...newDraftAction('start_sla'),
              timer: 'weekly' as unknown as 'customer_reply',
            },
          ],
        })
      )
    ).toContain('timer_invalid');
  });

  it('validateDraft accepts a valid draft for each new action', () => {
    expect(
      validateDraft(
        draft({
          trigger: 'stage_entered',
          stage: 'Docs',
          actions: [
            { ...newDraftAction('create_task'), templateKey: 'chase_docs' },
            newDraftAction('start_sla'),
          ],
        })
      )
    ).toEqual([]);
    expect(
      validateDraft(
        draft({
          trigger: 'last_required_doc_received',
          actions: [newDraftAction('advance_stage')],
        })
      )
    ).toEqual([]);
  });

  it('draftBody omits a blank dueHours and sends a number when set', () => {
    const base = draft({
      trigger: 'stage_entered',
      stage: ' Docs ',
      actions: [
        { ...newDraftAction('create_task'), templateKey: 'k', dueHours: '' },
      ],
    });
    expect(draftBody(base)?.actions[0]).toEqual({
      kind: 'create_task',
      templateKey: 'k',
      ownerRole: 'agent',
    });
    expect(draftBody(base)?.conditions.stage).toBe('Docs');
    const set = {
      ...base,
      actions: [{ ...base.actions[0], dueHours: ' 48 ' }],
    };
    expect(draftBody(set)?.actions[0]).toEqual({
      kind: 'create_task',
      templateKey: 'k',
      ownerRole: 'agent',
      dueHours: 48,
    });
    expect(
      draftBody(
        draft({
          trigger: 'last_required_doc_received',
          actions: [newDraftAction('advance_stage')],
        })
      )?.actions
    ).toEqual([{ kind: 'advance_stage' }]);
    expect(
      draftBody(
        draft({
          trigger: 'stage_entered',
          stage: 'Docs',
          actions: [
            { ...newDraftAction('start_sla'), timer: 'document_chase' },
          ],
        })
      )?.actions
    ).toEqual([{ kind: 'start_sla', timer: 'document_chase' }]);
  });

  it('describeRule words both triggers and the three actions', () => {
    const ctx = {
      t: echo,
      locale: 'en',
      bankName: (c: string) => c,
      personName: (u: string) => u,
    };
    const entered = rule({
      trigger: 'stage_entered',
      conditions: { stage: 'Docs', bank_code: 'ADCB' },
      actions: [
        task({ dueHours: 12 }),
        { kind: 'start_sla', timer: 'bank_response' },
      ],
    });
    const out = describeRule(entered, ctx);
    expect(out).toContain('describe.trigger.stage_entered{days=0,stage=Docs}');
    // The stage is in the trigger wording, so no separate stage clause.
    expect(out).not.toContain('describe.stage');
    expect(out).toContain('describe.bank');
    expect(out).toContain(
      'describe.action.create_task{task=chase_docs,owner=describe.owner.agent}'
    );
    expect(out).toContain(
      'describe.action.start_sla{timer=describe.timer.bank_response}'
    );
    expect(
      describeRule(entered, { ...ctx, templateName: () => 'Chase documents' })
    ).toContain('task=Chase documents');

    const adv = describeRule(
      rule({
        trigger: 'last_required_doc_received',
        actions: [{ kind: 'advance_stage' }],
      }),
      ctx
    );
    expect(adv).toContain('describe.trigger.last_required_doc_received');
    expect(adv).toContain('describe.action.advance_stage');
  });

  it('templateChoices puts the rule bank first and keeps a vanished key', () => {
    const byBank = new Map([
      [
        'ADCB',
        [
          { key: 'a', title: 'ADCB A' },
          { key: 'shared', title: 'ADCB shared' },
        ],
      ],
      [
        'ENBD',
        [
          { key: 'b', title: 'ENBD B' },
          { key: 'shared', title: 'ENBD shared' },
        ],
      ],
    ]);
    expect(templateChoices(byBank, 'ENBD')).toEqual([
      { key: 'b', title: 'ENBD B' },
      { key: 'shared', title: 'ENBD shared' },
      { key: 'a', title: 'ADCB A' },
    ]);
    expect(templateChoices(byBank, '', ['gone', 'a'])).toEqual([
      { key: 'a', title: 'ADCB A' },
      { key: 'shared', title: 'ADCB shared' },
      { key: 'b', title: 'ENBD B' },
      { key: 'gone', title: 'gone' },
    ]);
  });

  it('summariseRun names each new done kind and refusal code', () => {
    const run = (applied: RuleRunView['applied']): RuleRunView => ({
      ruleId: 'r',
      trigger: 'stage_entered',
      matched: true,
      applied,
      at: '2026-11-20T00:00:00Z',
    });
    expect(
      summariseRun(
        run([
          { kind: 'create_task', ok: true, refusal: null },
          { kind: 'start_sla', ok: true, refusal: null },
          { kind: 'advance_stage', ok: true, refusal: null },
        ]),
        echo
      )
    ).toBe(
      'run.matched · run.done.create_task · run.done.start_sla · run.done.advance_stage'
    );
    for (const code of [
      'TEMPLATE_NOT_FOUND',
      'OWNER_MISSING',
      'SLA_NOT_CONFIGURED',
      'FINAL_STAGE',
      'NO_NEXT_STAGE',
      'ADVANCE_CHAINED',
      'SUBMISSION_REQUIRED',
      'OWNER_INVALID',
      'DUE_INVALID',
      'PRESUB_REENTRY',
    ]) {
      expect(
        summariseRun(
          run([{ kind: 'create_task', ok: false, refusal: code }]),
          echo
        )
      ).toBe(`run.matched · run.stopped{reason=refusal.${code}}`);
    }
    expect(
      summariseRun(
        run([{ kind: 'advance_stage', ok: false, refusal: 'WAT' }]),
        echo
      )
    ).toContain('refusal.other');
  });
});
