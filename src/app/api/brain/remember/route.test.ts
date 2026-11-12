import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  ingestRemember: vi.fn(),
  rpc: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  contact: { data: { id: 'c' }, error: null } as {
    data: unknown;
    error: unknown;
  },
  enabled: true,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { brain_enabled: m.enabled },
            error: null,
          }),
        }),
      }),
    }),
    rpc: m.rpc,
  }),
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
}));
vi.mock('@/lib/brain/ingest', () => ({ ingestRemember: m.ingestRemember }));

import { brainSinkCounters } from '@/lib/brain/sink';

import { POST } from './route';

const CASE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const supabase = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => m.contact }) }),
  }),
};
const asRole = (role: string, salesRestricted = false) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    salesRestricted,
    supabase,
  });
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  m.contact = { data: { id: CONTACT }, error: null };
  asRole('agent');
  m.get.mockResolvedValue({ id: CASE, accountId: 'acct-1' });
  m.role.mockResolvedValue('agent');
  m.ingestRemember.mockResolvedValue({ ok: true, itemIds: ['i1'], skipped: 0 });
});

describe('POST /api/brain/remember', () => {
  it('stores as the session with the case and contact, 201', async () => {
    const res = await post({
      text: '  bank wants the salary letter  ',
      caseId: CASE,
      contactId: CONTACT,
      accountId: 'acct-evil',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ itemIds: ['i1'], duplicate: false });
    expect(m.ingestRemember).toHaveBeenCalledWith(
      expect.anything(),
      'u-1',
      'bank wants the salary letter',
      { accountId: 'acct-1', caseId: CASE, contactId: CONTACT }
    );
    expect(m.role).toHaveBeenCalledWith(CASE, 'u-1');
  });

  it('reports a duplicate when every chunk was already stored', async () => {
    m.ingestRemember.mockResolvedValue({ ok: true, itemIds: [], skipped: 1 });
    expect(await (await post({ text: 'x' })).json()).toEqual({
      itemIds: [],
      duplicate: true,
    });
  });

  it('answers 422 REDACTION_REFUSED and never logs the text', async () => {
    m.ingestRemember.mockResolvedValue({ ok: false, reason: 'too_long' });
    const res = await post({ text: 'secret text' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'REDACTION_REFUSED' });
    m.ingestRemember.mockRejectedValue(new Error('secret text'));
    expect((await post({ text: 'secret text' })).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });

  it('answers 404 for a case the caller cannot read or of another account', async () => {
    m.role.mockResolvedValue(null);
    expect((await post({ text: 'x', caseId: CASE })).status).toBe(404);
    m.role.mockResolvedValue('agent');
    m.get.mockResolvedValue({ id: CASE, accountId: 'acct-2' });
    expect((await post({ text: 'x', caseId: CASE })).status).toBe(404);
    expect(m.ingestRemember).not.toHaveBeenCalled();
  });

  it('answers 404 for a contact the caller cannot see', async () => {
    m.contact = { data: null, error: null };
    expect((await post({ text: 'x', contactId: CONTACT })).status).toBe(404);
    expect(m.ingestRemember).not.toHaveBeenCalled();
  });

  it('refuses a viewer, a restricted department and a switched-off account', async () => {
    asRole('viewer');
    expect((await post({ text: 'x' })).status).toBe(403);
    asRole('agent', true);
    expect((await post({ text: 'x' })).status).toBe(403);
    asRole('agent');
    m.enabled = false;
    const res = await post({ text: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    expect(m.ingestRemember).not.toHaveBeenCalled();
  });

  it('answers 400 for invalid bodies', async () => {
    for (const b of [
      { text: ' ' },
      { text: 'x'.repeat(4001) },
      { text: 'x', caseId: 'nope' },
      { text: 'x', contactId: 'nope' },
    ])
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect(m.ingestRemember).not.toHaveBeenCalled();
    expect((await post({ text: 'x'.repeat(4000) })).status).toBe(201);
  });

  it('marks the pages built from the new items dirty (022d-2)', async () => {
    m.rpc.mockResolvedValue({ data: 1, error: null });
    const res = await post({ text: 'bank wants the salary letter' });
    expect(res.status).toBe(201);
    expect(m.rpc).toHaveBeenCalledWith('brain_page_mark_dirty', {
      p_account: 'acct-1',
      p_item_ids: ['i1'],
    });
  });

  it('a failing dirty mark is counted and never changes the response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    brainSinkCounters.brain_page_dirty_failures = 0;
    m.rpc.mockRejectedValue(new Error('pages down'));
    const res = await post({ text: 'bank wants the salary letter' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ itemIds: ['i1'], duplicate: false });
    expect(brainSinkCounters.brain_page_dirty_failures).toBe(1);
  });

  it('no stored items: no dirty mark call', async () => {
    m.ingestRemember.mockResolvedValue({ ok: true, itemIds: [], skipped: 1 });
    expect((await post({ text: 'again' })).status).toBe(201);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
