import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
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

import { citeMarker } from '@/lib/brain/pages';

import { GET } from './route';

const CASE = '11111111-1111-4111-8111-111111111111';
const ITEM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const asRole = (role: string, salesRestricted = false) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    salesRestricted,
    supabase: {},
  });
const get = (kind: string, key: string) =>
  GET(new Request(`http://x/api/brain/pages/${kind}/${key}`), {
    params: Promise.resolve({ kind, key }),
  });

const pageRow = {
  summary: `AI-generated summary - verify against the case\n${citeMarker(ITEM_A)} salary letter asked`,
  version: 3,
  built_at: '2026-11-10T08:00:00.000Z',
  sources: [
    { id: ITEM_A, kind: 'note' },
    { id: ITEM_B, kind: 'message' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  asRole('viewer');
  m.rpc.mockResolvedValue({ data: [pageRow], error: null });
});

describe('GET /api/brain/pages/[kind]/[key]', () => {
  it('reads the page as the session and cites only the cited items', async () => {
    const res = await get('case', CASE);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      kind: 'case',
      key: CASE,
      summary: pageRow.summary,
      aiGenerated: true,
      version: 3,
      builtAt: '2026-11-10T08:00:00.000Z',
      citations: [{ kind: 'note', id: ITEM_A }],
    });
    expect(m.rpc).toHaveBeenCalledWith('brain_page_read', {
      p_actor: 'u-1',
      p_account: 'acct-1',
      p_kind: 'case',
      p_key: CASE,
    });
  });

  it('reads a bank page by its code', async () => {
    const res = await get('bank', 'ADCB');
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe('ADCB');
  });

  it('unknown kind, non-uuid key, missing and invisible page: one identical 404', async () => {
    const bodies: string[] = [];
    const unknownKind = await get('deal', CASE);
    bodies.push(await unknownKind.text());
    const badCase = await get('case', 'not-a-uuid');
    bodies.push(await badCase.text());
    const badContact = await get('contact', '12345');
    bodies.push(await badContact.text());
    m.rpc.mockResolvedValue({ data: [], error: null }); // missing or not visible
    const invisible = await get('case', CASE);
    bodies.push(await invisible.text());
    for (const r of [unknownKind, badCase, badContact, invisible])
      expect(r.status).toBe(404);
    expect(new Set(bodies)).toEqual(new Set([bodies[3]]));
    expect(JSON.parse(bodies[0])).toEqual({ error: 'Not found' });
    // Only the well-formed request reached the store.
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it('403 brain_disabled while the switch is off, before any store call', async () => {
    m.enabled = false;
    const res = await get('case', CASE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('refuses a restricted department', async () => {
    asRole('agent', true);
    expect((await get('case', CASE)).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
