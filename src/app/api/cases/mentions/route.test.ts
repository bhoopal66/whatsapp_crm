import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', async () => {
  const { CaseViews } = await import('@/lib/cases/views');
  return {
    caseViews: () =>
      new CaseViews(
        { rpc: m.rpc } as never,
        () => new Date('2026-11-10T09:00:00Z')
      ),
  };
});

import { GET } from './route';

const CASE = '11111111-1111-4111-8111-111111111111';
const CURSOR =
  '{"now": "2026-11-10T08:00:00.654321+00:00", "note_id": "n2", "created_at": "2026-11-09T10:00:00+00:00"}';
const row = (id: string) => ({
  note_id: id,
  case_id: CASE,
  stage: 'Submitted',
  author_id: 'u-other',
  system_author: null,
  created_at: '2026-11-09T10:00:00Z',
  body: 'see this',
  cursor: CURSOR,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
});

const get = (qs = '') => GET(new Request(`http://x/api/cases/mentions?${qs}`));

describe('GET /api/cases/mentions', () => {
  it('first page at the server clock; a full page answers next', async () => {
    m.rpc.mockResolvedValue({ data: [row('n1'), row('n2')], error: null });
    const res = await get('limit=2');
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('case_mentions', {
      p_actor: 'u-me',
      p_now: '2026-11-10T09:00:00.000Z',
      p_limit: 2,
      p_after: null,
    });
    const body = await res.json();
    expect(body.next).toBe(CURSOR);
    expect(body.items[0]).toEqual({
      noteId: 'n1',
      caseId: CASE,
      stage: 'Submitted',
      authorId: 'u-other',
      systemAuthor: null,
      createdAt: '2026-11-09T10:00:00.000Z',
      body: 'see this',
    });
  });

  it('after passes the cursor at its own clock; the last page has next null', async () => {
    m.rpc.mockResolvedValue({ data: [row('n3')], error: null });
    const res = await get(`after=${encodeURIComponent(CURSOR)}`);
    expect(m.rpc).toHaveBeenCalledWith('case_mentions', {
      p_actor: 'u-me',
      p_now: '2026-11-10T08:00:00.654321+00:00',
      p_limit: 50,
      p_after: CURSOR,
    });
    expect((await res.json()).next).toBeNull();
  });

  it.each([
    ['limit=0', 'LIMIT_INVALID'],
    ['limit=ten', 'LIMIT_INVALID'],
    ['after=notjson', 'CURSOR_INVALID'],
  ])('refuses %s with 422 %s before any call', async (qs, code) => {
    const res = await get(qs);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps a database refusal', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', hint: 'CURSOR_INVALID' },
    });
    expect((await get(`after=${encodeURIComponent(CURSOR)}`)).status).toBe(422);
  });
});
