import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  writer: null as null | boolean,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseNotesStore: () => ({ list: m.list, add: m.add }),
}));
// Every case role writes today (122), so a non-writer is simulated.
vi.mock('@/lib/cases/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cases/access')>();
  return {
    ...real,
    canWriteCase: (r: Parameters<typeof real.canWriteCase>[0]) =>
      m.writer ?? real.canWriteCase(r),
  };
});

import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const params = () => ({ params: Promise.resolve({ id: C }) });
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params()
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.writer = null;
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('agent');
  m.list.mockResolvedValue([{ id: 'n1', mentions: ['u-2'] }]);
  m.add.mockResolvedValue({
    noteId: 'n2',
    mentioned: ['u-2'],
    ignored: ['@bob'],
  });
});

describe('notes', () => {
  it('lists the notes with their mentions', async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({
      notes: [{ id: 'n1', mentions: ['u-2'] }],
    });
    expect(m.list).toHaveBeenCalledWith(C);
  });

  it('adds the trimmed note as the caller and answers 201', async () => {
    const res = await post({ body: '  call the bank  ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      noteId: 'n2',
      mentioned: ['u-2'],
      ignored: ['@bob'],
    });
    expect(m.add).toHaveBeenCalledWith(C, 'u-1', 'call the bank');
  });

  it('answers 404 to a caller with no case role (a viewer)', async () => {
    m.role.mockResolvedValue(null);
    expect((await post({ body: 'x' })).status).toBe(404);
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
    expect(m.add).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post({ body: 'x' })).status).toBe(404);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-writer', async () => {
    m.writer = false;
    expect((await post({ body: 'x' })).status).toBe(403);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('answers 400 for an empty or over-long body', async () => {
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(10001) })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(10000) })).status).toBe(201);
  });

  it('maps refusals and never logs the note text', async () => {
    m.add.mockRejectedValue(new CaseRefusedError('CASE_CLOSED'));
    const res = await post({ body: 'secret text' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CASE_CLOSED');
    m.add.mockRejectedValue(new CaseStoreError('case_note_add', '23514'));
    expect((await post({ body: 'secret text' })).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });
});
