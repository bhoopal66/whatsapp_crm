import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof real.requireRole>[0]) => {
      if (!hasMinRole(m.ctx.role as typeof min, min))
        throw new real.ForbiddenError('Insufficient role');
      return m.ctx;
    },
  };
});
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => m.admin,
}));

import { GET, PUT } from './route';

let rls: FakeClient;
let admin: FakeClient;
let setResult: { data?: unknown; error?: unknown };
let groupsResult: { data?: unknown; error?: unknown };
let stored: { managed: unknown; groups: unknown };
let filesRow: Record<string, unknown>[];
let filesStagesResult: { data?: unknown; error?: unknown };
const OFF = {
  checklistSync: false,
  readyMove: false,
  readyFromStage: null,
  readyToStage: null,
  intakePrompts: false,
};
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: rls.client };
};
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rls = new FakeClient(
    'rls',
    [],
    {},
    {
      case_account_settings: () => ({
        data: [{ managed_externally: true, submission_whatsapp_groups: true }],
      }),
    }
  );
  setResult = { data: true };
  groupsResult = { data: true };
  stored = { managed: true, groups: false };
  filesRow = [];
  filesStagesResult = { data: true };
  admin = new FakeClient('admin', [], {
    case_files_settings: () => ({ data: filesRow }) as never,
    case_settings_set_files_switch: (a) => ({ data: a.p_on }) as never,
    case_settings_set_files_ready_stages: () => filesStagesResult as never,
    case_settings_set: () => setResult as never,
    case_settings_set_whatsapp_groups: () => groupsResult as never,
    case_managed_externally: () => ({ data: stored.managed }) as never,
    case_submission_whatsapp_groups: () => ({ data: stored.groups }) as never,
  });
  m.admin = admin.client;
  as('admin');
});

describe('GET case settings', () => {
  it("reads the active account's row through RLS", async () => {
    as('agent');
    const res = await GET();
    expect(await res.json()).toEqual({
      settings: { managedExternally: true, submissionWhatsappGroups: true },
      caseFiles: OFF,
    });
    expect(rls.queries[0]!.filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
  });

  it('is off when the account never saved one', async () => {
    rls = new FakeClient('rls', [], {}, { case_account_settings: () => ({}) });
    as('agent');
    expect(await (await GET()).json()).toEqual({
      settings: { managedExternally: false, submissionWhatsappGroups: false },
      caseFiles: OFF,
    });
  });

  it('answers 403 to a viewer', async () => {
    as('viewer');
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT case settings', () => {
  it('sets it through case_settings_set for the caller and active account', async () => {
    const res = await put({ managed_externally: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { managedExternally: true, submissionWhatsappGroups: false },
    });
    expect(admin.rpcs[0]).toEqual({
      fn: 'case_settings_set',
      args: {
        p_actor: 'u-1',
        p_account: 'acct-1',
        p_managed_externally: true,
      },
    });
    expect(admin.rpcs.map((r) => r.fn)).not.toContain(
      'case_settings_set_whatsapp_groups'
    );
  });

  it('sets submission_whatsapp_groups alone and answers both stored values', async () => {
    stored = { managed: false, groups: true };
    const res = await put({ submission_whatsapp_groups: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { managedExternally: false, submissionWhatsappGroups: true },
    });
    expect(admin.rpcs[0]).toEqual({
      fn: 'case_settings_set_whatsapp_groups',
      args: { p_actor: 'u-1', p_account: 'acct-1', p_on: true },
    });
    expect(admin.rpcs.map((r) => r.fn)).not.toContain('case_settings_set');
  });

  it('sets both when both are sent', async () => {
    await put({ managed_externally: false, submission_whatsapp_groups: false });
    expect(admin.rpcs.slice(0, 2).map((r) => r.fn)).toEqual([
      'case_settings_set',
      'case_settings_set_whatsapp_groups',
    ]);
  });

  it('needs at least one key, each a boolean', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ submission_whatsapp_groups: 'on' })).status).toBe(400);
    expect(
      (await put({ managed_externally: true, submission_whatsapp_groups: 1 }))
        .status
    ).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('maps a NOT_ALLOWED on submission_whatsapp_groups to 403', async () => {
    groupsResult = { error: { hint: 'NOT_ALLOWED', code: '42501' } };
    expect((await put({ submission_whatsapp_groups: true })).status).toBe(403);
  });

  it('is admin-only and needs a boolean', async () => {
    as('team_leader');
    expect((await put({ managed_externally: true })).status).toBe(403);
    as('admin');
    expect((await put({ managed_externally: 'yes' })).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('maps the SQL refusal NOT_ALLOWED to 403', async () => {
    setResult = { error: { hint: 'NOT_ALLOWED', code: '42501' } };
    expect((await put({ managed_externally: false })).status).toBe(403);
  });
});

describe('case files settings', () => {
  const writes = () =>
    admin.rpcs
      .map((r) => r.fn)
      .filter((fn) => fn.startsWith('case_settings_set'));

  it('GET answers the stored file settings', async () => {
    filesRow = [
      {
        files_checklist_sync: true,
        files_ready_move: true,
        files_ready_from_stage: 'Submitted',
        files_ready_to_stage: 'Under review',
        files_intake_prompts: false,
      },
    ];
    as('agent');
    expect((await (await GET()).json()).caseFiles).toEqual({
      checklistSync: true,
      readyMove: true,
      readyFromStage: 'Submitted',
      readyToStage: 'Under review',
      intakePrompts: false,
    });
    expect(admin.rpcs).toContainEqual({
      fn: 'case_files_settings',
      args: { p_account: 'acct-1' },
    });
  });

  it('readyMove alone calls only that switch and answers caseFiles', async () => {
    const res = await put({ caseFiles: { readyMove: true } });
    expect(res.status).toBe(200);
    expect(writes()).toEqual(['case_settings_set_files_switch']);
    expect(admin.rpcs).toContainEqual({
      fn: 'case_settings_set_files_switch',
      args: {
        p_actor: 'u-1',
        p_account: 'acct-1',
        p_switch: 'files_ready_move',
        p_on: true,
      },
    });
    const json = await res.json();
    expect(json.caseFiles).toEqual(OFF);
    expect(json.settings).toEqual({
      managedExternally: true,
      submissionWhatsappGroups: false,
    });
  });

  it('a stage pair calls the stages setter once', async () => {
    await put({
      caseFiles: { readyFromStage: 'Submitted', readyToStage: 'Approved' },
    });
    expect(writes()).toEqual(['case_settings_set_files_ready_stages']);
    expect(
      admin.rpcs.find((r) => r.fn === 'case_settings_set_files_ready_stages')!
        .args
    ).toEqual({
      p_actor: 'u-1',
      p_account: 'acct-1',
      p_from: 'Submitted',
      p_to: 'Approved',
    });
  });

  it('clears the pair with two nulls', async () => {
    await put({ caseFiles: { readyFromStage: null, readyToStage: null } });
    expect(
      admin.rpcs.find((r) => r.fn === 'case_settings_set_files_ready_stages')!
        .args
    ).toMatchObject({ p_from: null, p_to: null });
  });

  it('leaves caseFiles out of a PUT that did not send it', async () => {
    const json = await (await put({ managed_externally: true })).json();
    expect(json).not.toHaveProperty('caseFiles');
    expect(admin.rpcs.map((r) => r.fn)).not.toContain('case_files_settings');
  });

  it('answers 400 for a bad caseFiles, before any write', async () => {
    for (const caseFiles of [
      'on',
      { readyMove: 'yes' },
      { unknown: true },
      { readyFromStage: 'Submitted' },
      { readyFromStage: ' ', readyToStage: 'Approved' },
      { readyFromStage: 3, readyToStage: 'Approved' },
    ])
      expect((await put({ caseFiles })).status).toBe(400);
    expect((await put({ caseFiles: {} })).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('maps SETTING_INVALID to 422 and NOT_ALLOWED to 403', async () => {
    filesStagesResult = { error: { hint: 'SETTING_INVALID', code: '23514' } };
    const res = await put({
      caseFiles: { readyFromStage: 'Approved', readyToStage: 'Submitted' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SETTING_INVALID');
    as('agent');
    expect((await put({ caseFiles: { readyMove: true } })).status).toBe(403);
  });
});
