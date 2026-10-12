import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createFakeDb,
  type FakeDb,
  type Result,
  type Row,
} from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { PATCH } from './route';

const CALL = '00000000-0000-4000-8000-000000000001';
const HIDDEN = '00000000-0000-4000-8000-000000000002';
let rls: FakeDb;
let setDisposition: Mock<(args: Row) => Result>;

beforeEach(() => {
  vi.clearAllMocks();
  // As pbx_set_disposition: writes both fields, trimmed notes.
  setDisposition = vi.fn((args: Row) => {
    const row = rls.tables.calls.find((c) => c.id === args.p_call_id)!;
    if (row.erased_at)
      return {
        data: null,
        error: { code: '55000', message: 'This call was erased' },
      };
    Object.assign(row, {
      disposition: args.p_disposition,
      notes: (args.p_notes as string | null)?.trim() || null,
      notes_updated_at: '2026-10-12T10:00:00Z',
    });
    return { data: null, error: null };
  });
  rls = createFakeDb(
    {
      calls: [
        { id: CALL, disposition: 'call_back', notes: 'old', erased_at: null },
      ],
    },
    { pbx_set_disposition: setDisposition }
  );
  mocks.requireRole.mockResolvedValue({
    accountId: 'a',
    userId: 'u',
    role: 'agent',
    supabase: rls.db,
  });
});

const patch = (body: unknown, id = CALL) =>
  PATCH(
    new Request(`https://crm.example.com/api/pbx/calls/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

describe('PATCH /api/pbx/calls/[callId]', () => {
  it('needs an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await patch({ notes: 'x' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('saves one field and keeps the other', async () => {
    let res = await patch({ notes: ' new notes ' });
    expect(res.status).toBe(200);
    expect(setDisposition).toHaveBeenLastCalledWith({
      p_call_id: CALL,
      p_disposition: 'call_back',
      p_notes: ' new notes ',
    });
    expect(await res.json()).toEqual({
      disposition: 'call_back',
      notes: 'new notes',
      notesUpdatedAt: '2026-10-12T10:00:00Z',
    });
    res = await patch({ disposition: null });
    expect(setDisposition).toHaveBeenLastCalledWith({
      p_call_id: CALL,
      p_disposition: null,
      p_notes: 'new notes',
    });
    expect((await res.json()).disposition).toBeNull();
  });

  it('validates before asking the database', async () => {
    for (const body of [
      {},
      { disposition: 'sold' },
      { notes: 42 },
      { notes: 'x'.repeat(4001) },
      ['notes'],
    ])
      expect((await patch(body)).status).toBe(400);
    expect((await patch({ notes: `  ${'x'.repeat(4000)}  ` })).status).toBe(
      200
    );
    expect(setDisposition).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a call the caller cannot see', async () => {
    expect((await patch({ notes: 'x' }, HIDDEN)).status).toBe(404);
    expect((await patch({ notes: 'x' }, 'not-an-id')).status).toBe(404);
    expect(setDisposition).not.toHaveBeenCalled();
  });

  it('maps the function’s refusals', async () => {
    rls.tables.calls[0].erased_at = '2026-10-11T00:00:00Z';
    let res = await patch({ disposition: 'interested' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This call was erased' });
    rls.rpcs.pbx_set_disposition = () => ({
      data: null,
      error: {
        code: '42501',
        message:
          'Only the person on the call or a team leader can record its outcome',
      },
    });
    res = await patch({ disposition: 'interested' });
    expect(res.status).toBe(403);
    rls.rpcs.pbx_set_disposition = () => ({
      data: null,
      error: { code: '22023', message: 'Unknown disposition' },
    });
    expect((await patch({ disposition: 'interested' })).status).toBe(400);
  });
});
