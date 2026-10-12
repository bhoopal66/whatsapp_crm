import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Reply } from '@/lib/journeys/host/fake-db';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  handle: vi.fn(),
  createRunner: vi.fn(),
  ensureOpenFile: vi.fn(),
  admin: { tag: 'service-role' },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: { message: string; status?: number }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => h.admin,
}));
vi.mock('@/lib/journeys/runner', async (orig) => ({
  ...(await orig<typeof import('@/lib/journeys/runner')>()),
  createRunner: h.createRunner,
}));
vi.mock('@/lib/journeys/host/sink', () => ({
  createJourneySink: () => ({ deliver: vi.fn() }),
}));
vi.mock('@/lib/journeys/host/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/journeys/host/store')>()),
  ensureOpenFile: h.ensureOpenFile,
}));

import { POST } from './route';

const CONTACT = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const FILE_ID = '0b8f7a3e-6a0d-4c8e-9a51-1f2e3d4c5b6a';
const KEY = 'taamul_welcome_to_close.v1';
const OPTED_IN = {
  id: CONTACT,
  marketing_opt_in_at: '2026-10-01T00:00:00Z',
  opted_out_at: null,
  do_not_contact_at: null,
};
const ENABLED: Reply = { data: { enabled: true, workflow_key: KEY } };

function setup(...replies: Reply[]) {
  const { db, queries } = fakeDb(...replies);
  h.requireRole.mockResolvedValue({
    supabase: db,
    userId: 'user-1',
    accountId: 'acc-1',
    role: 'agent',
  });
  return queries;
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/journeys/start', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

describe('POST /api/journeys/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createRunner.mockReturnValue({ handle: h.handle });
    h.ensureOpenFile.mockResolvedValue(FILE_ID);
  });

  it('needs an agent', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 })
    );
    expect((await post({ contactId: CONTACT })).status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('agent');
  });

  it('opens the file and runs START_COLD on the service-role client', async () => {
    const queries = setup({ data: OPTED_IN }, ENABLED);
    h.handle.mockResolvedValue({
      status: 'ok',
      result: {
        file: { state: 'S_MENU', outcome: null },
        actions: [],
        warnings: [],
      },
      drain: { delivered: 2, pending: 0 },
    });
    const res = await post({ contactId: CONTACT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fileId: FILE_ID,
      state: 'S_MENU',
      outcome: null,
      warnings: [],
    });
    expect(queries[0]).toEqual(
      expect.arrayContaining([
        ['from', 'contacts'],
        ['eq', 'id', CONTACT],
        ['eq', 'account_id', 'acc-1'],
      ])
    );
    expect(h.ensureOpenFile).toHaveBeenCalledWith(h.admin, {
      accountId: 'acc-1',
      contactId: CONTACT,
      workflowKey: KEY,
    });
    expect(h.handle.mock.calls[0][0]).toMatchObject({
      type: 'START_COLD',
      fileId: FILE_ID,
    });
  });

  it.each([
    [{ opted_out_at: '2026-10-02T00:00:00Z' }, 'OPTED_OUT'],
    [{ do_not_contact_at: '2026-10-02T00:00:00Z' }, 'DO_NOT_CONTACT'],
    [{ marketing_opt_in_at: null }, 'NO_MARKETING_OPT_IN'],
  ])('refuses a customer without consent (%o → %s)', async (patch, code) => {
    setup({ data: { ...OPTED_IN, ...patch } }, ENABLED);
    const res = await post({ contactId: CONTACT });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
    expect(h.ensureOpenFile).not.toHaveBeenCalled();
  });

  it('refuses while the bot is switched off', async () => {
    for (const settings of [
      { data: null },
      { data: { enabled: false, workflow_key: KEY } },
    ]) {
      setup({ data: OPTED_IN }, settings);
      const res = await post({ contactId: CONTACT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'JOURNEYS_DISABLED' });
    }
    expect(h.ensureOpenFile).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad contact id and 404 for one the caller cannot see', async () => {
    setup();
    expect((await post({})).status).toBe(400);
    expect((await post({ contactId: 'x' })).status).toBe(400);
    setup({ data: null });
    expect((await post({ contactId: CONTACT })).status).toBe(404);
    expect(h.ensureOpenFile).not.toHaveBeenCalled();
  });

  it("maps the engine's rejection to 400 with its code", async () => {
    setup({ data: OPTED_IN }, ENABLED);
    h.handle.mockResolvedValue({
      status: 'rejected',
      error: { code: 'NO_CONSENT', message: 'COLD entry refused' },
    });
    const res = await post({ contactId: CONTACT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'COLD entry refused',
      code: 'NO_CONSENT',
    });
  });
});
