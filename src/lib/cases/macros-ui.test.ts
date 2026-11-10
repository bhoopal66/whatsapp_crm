import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

import {
  MACRO_ACTIONS_MAX,
  MACRO_NOTE_PLACEHOLDERS,
  blankAction,
  macroBody,
  macroErrorKey,
  moveAction,
  parseApplyResult,
  parseMacros,
  parseSavedMacro,
  stageAction,
  summariseApplyResult,
  validateMacroDraft,
  type MacroAction,
} from './macros-ui';

const ROW = {
  id: 'm1',
  accountId: 'a1',
  ownerUserId: 'u1',
  name: 'Chase docs',
  actions: [
    { kind: 'add_task', templateKey: 'call_customer', ownerRole: 'me' },
    { kind: 'add_note', body: 'Hi {{customer}}' },
  ],
  shared: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};

describe('parseMacros', () => {
  it('reads a list and drops junk rows and junk actions', () => {
    const list = parseMacros({
      macros: [
        ROW,
        null,
        'x',
        { id: 'm2' },
        {
          ...ROW,
          id: 'm3',
          shared: 'yes',
          actions: [
            { kind: 'add_task', templateKey: 'k', ownerRole: 'boss' },
            { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
            { kind: 'explode' },
            { kind: 'request_documents', extra: 1 },
            {
              kind: 'add_task',
              templateKey: 'k',
              ownerRole: 'agent',
              dueHours: 24,
            },
          ],
        },
      ],
    });
    expect(list?.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(list?.[0].shared).toBe(true);
    expect(list?.[1].shared).toBe(false);
    expect(list?.[1].actions).toEqual([
      { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
      { kind: 'request_documents' },
      { kind: 'add_task', templateKey: 'k', ownerRole: 'agent', dueHours: 24 },
    ]);
  });

  it('is null for an answer that is not a list', () => {
    expect(parseMacros(null)).toBeNull();
    expect(parseMacros({ macros: {} })).toBeNull();
    expect(parseMacros('[]')).toBeNull();
    expect(parseMacros({ macros: [] })).toEqual([]);
  });

  it('reads a saved macro', () => {
    expect(parseSavedMacro({ macro: ROW })?.name).toBe('Chase docs');
    expect(parseSavedMacro({ macro: { id: 1 } })).toBeNull();
    expect(parseSavedMacro(undefined)).toBeNull();
  });
});

describe('validateMacroDraft', () => {
  const task: MacroAction = {
    kind: 'add_task',
    templateKey: 'call_customer',
    ownerRole: 'agent',
  };
  const ok = (actions: MacroAction[], name = 'Macro') =>
    validateMacroDraft({ name, actions });

  it('accepts a good draft', () => {
    expect(
      ok([
        { ...task, dueHours: 1 },
        { ...task, dueHours: 8760 },
        { kind: 'add_note', body: 'x'.repeat(4000) },
        { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
        { kind: 'set_stage', stage: 'Review' },
        { kind: 'request_documents' },
      ])
    ).toBeNull();
    expect(ok([task], `  ${'n'.repeat(60)}  `)).toBeNull();
  });

  it('checks the name: 1..60 characters, not blank', () => {
    expect(ok([task], '')).toEqual({ kind: 'name' });
    expect(ok([task], ' \t\n')).toEqual({ kind: 'name' });
    expect(ok([task], 'n'.repeat(61))).toEqual({ kind: 'name' });
  });

  it('checks the action count: 1..10', () => {
    expect(ok([])).toEqual({ kind: 'noActions' });
    expect(ok(Array(MACRO_ACTIONS_MAX).fill(task))).toBeNull();
    expect(ok(Array(MACRO_ACTIONS_MAX + 1).fill(task))).toEqual({
      kind: 'tooManyActions',
    });
  });

  it.each([
    [{ ...task, templateKey: '' }, 'templateKey'],
    [{ ...task, templateKey: 'Call' }, 'templateKey'],
    [{ ...task, templateKey: 'a'.repeat(65) }, 'templateKey'],
    [{ ...task, dueHours: 0 }, 'dueHours'],
    [{ ...task, dueHours: 8761 }, 'dueHours'],
    [{ ...task, dueHours: 1.5 }, 'dueHours'],
    [{ ...task, dueHours: Number.NaN }, 'dueHours'],
    [{ ...task, ownerRole: 'boss' }, 'ownerRole'],
    [{ kind: 'add_note', body: '' }, 'body'],
    [{ kind: 'add_note', body: '\t \n' }, 'body'],
    [{ kind: 'add_note', body: 'x'.repeat(4001) }, 'body'],
    [{ kind: 'set_stage', stage: ' ' }, 'stage'],
    [{ kind: 'set_stage', stage: 's'.repeat(61) }, 'stage'],
    [{ kind: 'set_stage', stage: 'Closed', outcome: 'Closed' }, 'outcome'],
    [{ kind: 'nope' }, 'kind'],
  ])('refuses %j as %s, naming its position', (bad, problem) => {
    expect(ok([task, bad as MacroAction])).toEqual({
      kind: 'action',
      index: 1,
      problem,
    });
  });
});

describe('draft helpers', () => {
  it('gives an outcome stage itself as its outcome', () => {
    expect(stageAction('Declined')).toEqual({
      kind: 'set_stage',
      stage: 'Declined',
      outcome: 'Declined',
    });
    expect(stageAction('Closed')).toEqual({
      kind: 'set_stage',
      stage: 'Closed',
    });
    expect(blankAction('add_task', 'k')).toEqual({
      kind: 'add_task',
      templateKey: 'k',
      ownerRole: 'agent',
    });
  });

  it('moves an action and ignores moves off either end', () => {
    expect(moveAction(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveAction(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveAction(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveAction(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('sends shared only for someone who may share', () => {
    const draft = { name: ' M ', actions: [], shared: true };
    expect(macroBody(draft, null, false)).toEqual({ name: 'M', actions: [] });
    expect(macroBody(draft, 'id', true)).toEqual({
      macroId: 'id',
      name: 'M',
      actions: [],
      shared: true,
    });
  });

  it('maps refusals to message keys that exist in both catalogues', () => {
    const keys = [
      macroErrorKey(422, 'NAME_INVALID'),
      macroErrorKey(422, 'ACTION_INVALID'),
      macroErrorKey(403, 'NOT_ALLOWED'),
      macroErrorKey(404, 'MACRO_NOT_FOUND'),
      macroErrorKey(403, undefined),
      macroErrorKey(404, 'CASE_NOT_FOUND'),
      macroErrorKey(500, 'X'),
    ];
    expect(keys).toEqual([
      'nameInvalid',
      'actionInvalid',
      'notAllowed',
      'notFound',
      'notAllowed',
      'notFound',
      'generic',
    ]);
    for (const k of keys) {
      expect(en.CaseMacros.errors).toHaveProperty(k);
      expect(ko.CaseMacros.errors).toHaveProperty(k);
    }
  });

  it('keeps the placeholders out of the message catalogues', () => {
    expect(MACRO_NOTE_PLACEHOLDERS).toEqual(['{{customer}}', '{{bank}}']);
    expect(JSON.stringify(en.CaseMacros)).not.toContain('{{');
  });
});

describe('parseApplyResult + summariseApplyResult', () => {
  const actions: MacroAction[] = [
    { kind: 'add_task', templateKey: 'k', ownerRole: 'me' },
    { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
    { kind: 'add_note', body: 'n' },
    { kind: 'request_documents' },
  ];

  it('summarises a full run with a group end', () => {
    const r = parseApplyResult({
      applied: [
        { kind: 'add_task', ok: true },
        {
          kind: 'set_stage',
          ok: true,
          groupEnd: {
            groupEnded: true,
            reason: 'ENDED',
            end: { closed: true },
          },
        },
        { kind: 'add_note', ok: true },
        { kind: 'request_documents', ok: true },
      ],
      documentRequestPreview: 'Please send: payslip',
    });
    expect(r?.documentRequestPreview).toBe('Please send: payslip');
    expect(r?.stoppedAt).toBeNull();
    expect(summariseApplyResult(r!, actions)).toEqual([
      { key: 'taskAdded' },
      { key: 'stageMoved', stage: 'Approved' },
      { key: 'groupEnded' },
      { key: 'noteAdded' },
      { key: 'documentsPreviewed' },
    ]);
  });

  it('says where a run stopped, 1-based, with the reason', () => {
    const r = parseApplyResult({
      applied: [
        { kind: 'add_task', ok: true },
        {
          kind: 'set_stage',
          ok: false,
          code: 'CASE_CLOSED',
          reason: 'The case is closed',
        },
      ],
      stoppedAt: {
        index: 1,
        code: 'CASE_CLOSED',
        reason: 'The case is closed',
      },
    });
    expect(summariseApplyResult(r!, actions)).toEqual([
      { key: 'taskAdded' },
      { key: 'stopped', step: 2, reason: 'The case is closed' },
    ]);
  });

  it('falls back to the code when the reason is missing', () => {
    const r = parseApplyResult({
      applied: [{ kind: 'add_task', ok: false, code: 'FAILED' }],
      stoppedAt: { index: 0, code: 'FAILED' },
    });
    expect(summariseApplyResult(r!, actions)).toEqual([
      { key: 'stopped', step: 1, reason: 'FAILED' },
    ]);
  });

  it('shows a pending and a failed group end', () => {
    const pending = parseApplyResult({
      applied: [
        { kind: 'add_task', ok: true },
        {
          kind: 'set_stage',
          ok: true,
          groupEnd: { groupEnded: false, reason: 'CLAIM_HELD', end: null },
        },
      ],
    });
    expect(summariseApplyResult(pending!, actions)[2]).toEqual({
      key: 'groupEndPending',
    });
    const failed = parseApplyResult({
      applied: [
        { kind: 'add_task', ok: true },
        {
          kind: 'set_stage',
          ok: true,
          groupEnd: { groupEnded: false, reason: 'END_FAILED', end: null },
        },
      ],
    });
    expect(summariseApplyResult(failed!, actions)[2]).toEqual({
      key: 'groupEndFailed',
    });
    const noGroup = parseApplyResult({
      applied: [
        { kind: 'add_task', ok: true },
        { kind: 'set_stage', ok: true, groupEnd: { reason: 'NO_GROUP' } },
      ],
    });
    expect(summariseApplyResult(noGroup!, actions)).toHaveLength(2);
  });

  it('tolerates junk', () => {
    expect(parseApplyResult(null)).toBeNull();
    expect(parseApplyResult({ applied: 'x' })).toBeNull();
    const r = parseApplyResult({
      applied: [null, { kind: 1, ok: true }, { kind: 'zap', ok: true }],
      documentRequestPreview: '   ',
      stoppedAt: { index: -1, code: 'X' },
    });
    expect(r).toEqual({
      applied: [
        {
          kind: 'zap',
          ok: true,
          code: null,
          reason: null,
          groupEnd: null,
        },
      ],
      documentRequestPreview: null,
      stoppedAt: null,
    });
    expect(summariseApplyResult(r!, [])).toEqual([{ key: 'unknown' }]);
  });
});
