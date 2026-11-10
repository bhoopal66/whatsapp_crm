import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalText } from './http';
import {
  applyMacro,
  CaseMacroStore,
  fillNotePlaceholders,
  type ApplyMacroDeps,
  type MacroAction,
} from './macros';
import { CaseRefusedError } from './store';
import type { Case } from './types';

const NOW = new Date('2026-11-10T08:00:00.000Z');
const ACTOR = 'u-me';
const MACRO = 'm-1';

const aCase = (over: Partial<Case> = {}): Case =>
  ({
    id: 'c-1',
    accountId: 'acct-1',
    groupId: 'g-1',
    agentId: 'u-agent',
    coordinatorId: 'u-coord',
    contactName: 'Acme $& Co',
    bankName: 'ADCB',
    stage: 'New',
    ...over,
  }) as Case;

type Deps = ApplyMacroDeps;

function deps(actions: MacroAction[]) {
  const d = {
    macros: {
      get: vi.fn(async () => ({
        id: MACRO,
        accountId: 'acct-1',
        ownerUserId: ACTOR,
        name: 'Chase',
        actions,
        shared: false,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })),
      logApply: vi.fn<Deps['macros']['logApply']>(async () => '1'),
    },
    cases: {
      setStage: vi.fn<Deps['cases']['setStage']>(async () => ({
        moved: true,
        fromStage: 'New',
        toStage: 'Approved',
        outcome: 'Approved',
        groupEnd: null,
      })),
    },
    tools: {
      createTask: vi.fn<Deps['tools']['createTask']>(async () => 't-1'),
      docRequestBegin: vi.fn(async () => ({
        accountId: 'acct-1',
        groupId: 'g-1',
        submissionRef: 'S-1',
        bankName: 'ADCB',
        docKeys: ['passport', 'salary'],
        docLabels: ['Passport', 'Salary certificate'],
      })),
      // Present on the real store; a macro must never reach them.
      docMarkRequested: vi.fn(async () => 2),
      sendFromCrm: vi.fn(),
    },
    notes: {
      add: vi.fn(async () => ({ noteId: 'n-1', mentioned: [], ignored: [] })),
    },
    refusalText,
  };
  return d;
}

const run = (d: ReturnType<typeof deps>, c = aCase()) =>
  applyMacro(d, { case: c, actor: ACTOR, macroId: MACRO, now: NOW });

beforeEach(() => vi.restoreAllMocks());

describe('applyMacro', () => {
  it('an invisible macro throws before anything is written or logged', async () => {
    const d = deps([{ kind: 'add_note', body: 'x' }]);
    d.macros.get.mockRejectedValue(new CaseRefusedError('MACRO_NOT_FOUND'));
    await expect(run(d)).rejects.toMatchObject({ reason: 'MACRO_NOT_FOUND' });
    expect(d.notes.add).not.toHaveBeenCalled();
    expect(d.macros.logApply).not.toHaveBeenCalled();
  });

  it('add_task: owner by role, due from dueHours, else NULL', async () => {
    const d = deps([
      {
        kind: 'add_task',
        templateKey: 'call',
        ownerRole: 'agent',
        dueHours: 24,
      },
      { kind: 'add_task', templateKey: 'chase', ownerRole: 'coordinator' },
      { kind: 'add_task', templateKey: 'mine', ownerRole: 'me', dueHours: 1 },
    ]);
    const r = await run(d);
    expect(r.stoppedAt).toBeUndefined();
    expect(d.tools.createTask.mock.calls.map((c) => c[0])).toEqual([
      {
        caseId: 'c-1',
        actor: ACTOR,
        templateKey: 'call',
        ownerId: 'u-agent',
        dueAt: new Date('2026-11-11T08:00:00.000Z'),
      },
      {
        caseId: 'c-1',
        actor: ACTOR,
        templateKey: 'chase',
        ownerId: 'u-coord',
        dueAt: null,
      },
      {
        caseId: 'c-1',
        actor: ACTOR,
        templateKey: 'mine',
        ownerId: ACTOR,
        dueAt: new Date('2026-11-10T09:00:00.000Z'),
      },
    ]);
  });

  it('add_task for a coordinator on a case with none passes NULL (the default)', async () => {
    const d = deps([
      { kind: 'add_task', templateKey: 'chase', ownerRole: 'coordinator' },
    ]);
    await run(d, aCase({ coordinatorId: null }));
    expect(d.tools.createTask.mock.lastCall?.[0].ownerId).toBeNull();
  });

  it('add_note fills {{customer}} and {{bank}} literally', async () => {
    const d = deps([
      {
        kind: 'add_note',
        body: 'Called {{customer}} about {{bank}}; {{bank}} again',
      },
    ]);
    await run(d);
    expect(d.notes.add).toHaveBeenCalledWith(
      'c-1',
      ACTOR,
      'Called Acme $& Co about ADCB; ADCB again'
    );
    expect(
      fillNotePlaceholders('{{customer}}/{{bank}}', {
        contactName: null,
        bankName: null,
      })
    ).toBe('/');
  });

  it('a refused set_stage stops the run, reports stoppedAt and still logs', async () => {
    const d = deps([
      { kind: 'add_note', body: 'first' },
      { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
      { kind: 'add_task', templateKey: 'never', ownerRole: 'me' },
    ]);
    d.cases.setStage.mockRejectedValue(
      new CaseRefusedError('MANAGED_EXTERNALLY')
    );
    const r = await run(d);
    expect(d.cases.setStage).toHaveBeenCalledWith(
      'c-1',
      ACTOR,
      'Approved',
      'Approved'
    );
    expect(d.tools.createTask).not.toHaveBeenCalled();
    expect(r.applied).toEqual([
      { kind: 'add_note', ok: true },
      {
        kind: 'set_stage',
        ok: false,
        code: 'MANAGED_EXTERNALLY',
        reason: refusalText('MANAGED_EXTERNALLY'),
      },
    ]);
    expect(r.stoppedAt).toEqual({
      index: 1,
      code: 'MANAGED_EXTERNALLY',
      reason: refusalText('MANAGED_EXTERNALLY'),
    });
    expect(d.macros.logApply).toHaveBeenCalledTimes(1);
    expect(d.macros.logApply).toHaveBeenCalledWith(ACTOR, 'c-1', MACRO, [
      { kind: 'add_note', ok: true, refusal: null },
      { kind: 'set_stage', ok: false, refusal: 'MANAGED_EXTERNALLY' },
    ]);
  });

  it('set_stage reports the group-end outcome as the stage route does', async () => {
    const d = deps([{ kind: 'set_stage', stage: 'Approved' }]);
    const groupEnd = { groupEnded: true, reason: 'ENDED' as const, end: null };
    d.cases.setStage.mockResolvedValue({
      moved: true,
      fromStage: 'New',
      toStage: 'Approved',
      outcome: null,
      groupEnd,
    });
    const r = await run(d);
    expect(d.cases.setStage).toHaveBeenCalledWith(
      'c-1',
      ACTOR,
      'Approved',
      null
    );
    expect(r.applied).toEqual([{ kind: 'set_stage', ok: true, groupEnd }]);
  });

  it('request_documents returns a preview and never sends or marks', async () => {
    const d = deps([{ kind: 'request_documents' }]);
    const r = await run(d);
    expect(d.tools.docRequestBegin).toHaveBeenCalledWith('c-1', ACTOR);
    expect(r.documentRequestPreview).toBe(
      'To continue your ADCB application we still need the following documents: Passport, Salary certificate. Please share them in this chat.'
    );
    expect(d.tools.docMarkRequested).not.toHaveBeenCalled();
    expect(d.tools.sendFromCrm).not.toHaveBeenCalled();
    expect(r.applied).toEqual([{ kind: 'request_documents', ok: true }]);
  });

  it('request_documents on a lead stops with NO_GROUP', async () => {
    const d = deps([{ kind: 'request_documents' }]);
    const r = await run(d, aCase({ groupId: null }));
    expect(d.tools.docRequestBegin).not.toHaveBeenCalled();
    expect(r.stoppedAt).toMatchObject({ index: 0, code: 'NO_GROUP' });
  });

  it('a store failure stops the run as FAILED and is still logged', async () => {
    const d = deps([
      { kind: 'add_note', body: 'x' },
      { kind: 'request_documents' },
    ]);
    d.notes.add.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run(d);
    expect(r.stoppedAt).toMatchObject({ index: 0, code: 'FAILED' });
    expect(d.macros.logApply).toHaveBeenCalledWith(ACTOR, 'c-1', MACRO, [
      { kind: 'add_note', ok: false, refusal: 'FAILED' },
    ]);
  });

  it('logs one row with every attempted action of a full run', async () => {
    const d = deps([
      { kind: 'add_task', templateKey: 'call', ownerRole: 'me' },
      { kind: 'add_note', body: 'n' },
      { kind: 'request_documents' },
      { kind: 'set_stage', stage: 'Submitted' },
    ]);
    await run(d);
    expect(d.macros.logApply).toHaveBeenCalledTimes(1);
    expect(d.macros.logApply.mock.lastCall?.[3]).toEqual([
      { kind: 'add_task', ok: true, refusal: null },
      { kind: 'add_note', ok: true, refusal: null },
      { kind: 'request_documents', ok: true, refusal: null },
      { kind: 'set_stage', ok: true, refusal: null },
    ]);
  });
});

describe('CaseMacroStore', () => {
  const row = {
    macro_id: 'm-1',
    account_id: 'acct-1',
    owner_user_id: ACTOR,
    name: 'Chase',
    actions: [{ kind: 'request_documents' }],
    shared: true,
    created_at: '2026-11-10T08:00:00+00:00',
    updated_at: '2026-11-10T08:00:00+00:00',
  };

  it('maps rows and passes the 186 argument names', async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const s = new CaseMacroStore({ rpc } as never, () => NOW);
    const m = await s.save(ACTOR, {
      macroId: null,
      name: 'Chase',
      actions: [{ kind: 'request_documents' }],
      shared: true,
    });
    expect(rpc).toHaveBeenCalledWith('case_macro_save', {
      p_actor: ACTOR,
      p_macro: null,
      p_name: 'Chase',
      p_actions: [{ kind: 'request_documents' }],
      p_shared: true,
    });
    expect(m).toEqual({
      id: 'm-1',
      accountId: 'acct-1',
      ownerUserId: ACTOR,
      name: 'Chase',
      actions: [{ kind: 'request_documents' }],
      shared: true,
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
    });
    await s.logApply(ACTOR, 'c-1', 'm-1', [
      { kind: 'request_documents', ok: true, refusal: null },
    ]);
    expect(rpc).toHaveBeenLastCalledWith('case_macro_log_apply', {
      p_actor: ACTOR,
      p_case: 'c-1',
      p_macro: 'm-1',
      p_applied: [{ kind: 'request_documents', ok: true, refusal: null }],
      p_now: NOW.toISOString(),
    });
  });

  it('a hint refusal becomes CaseRefusedError', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: 'P0002', hint: 'MACRO_NOT_FOUND' },
    }));
    const s = new CaseMacroStore({ rpc } as never);
    await expect(s.get(ACTOR, 'm-x')).rejects.toMatchObject({
      reason: 'MACRO_NOT_FOUND',
    });
  });
});
