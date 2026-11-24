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
let saveNote: Mock<(args: Row) => Result>;

beforeEach(() => {
  vi.clearAllMocks();
  // As pbx_save_call_note: the fields sent, a note over the text seen.
  saveNote = vi.fn((args: Row) => {
    const row = rls.tables.calls.find((c) => c.id === args.p_call_id);
    const f = args.p_fields as Row;
    if (!row)
      return {
        data: null,
        error: { code: 'P0002', message: 'Call not found' },
      };
    if (row.erased_at)
      return {
        data: null,
        error: { code: '55000', message: 'This call was erased' },
      };
    if ('notes' in f) {
      if ('notes_seen' in f && f.notes_seen !== row.notes)
        return { data: { conflict: true, notes: row.notes }, error: null };
      row.notes = (f.notes as string | null)?.trim() || null;
      row.notes_updated_at = '2026-10-12T10:00:00Z';
    }
    if ('disposition' in f) row.disposition = f.disposition;
    const { disposition, notes, notes_updated_at } = row;
    return { data: { disposition, notes, notes_updated_at }, error: null };
  });
  rls = createFakeDb(
    {
      calls: [
        { id: CALL, disposition: 'call_back', notes: 'old', erased_at: null },
      ],
    },
    { pbx_save_call_note: saveNote }
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

  it('writes only the fields it was sent', async () => {
    let res = await patch({ notes: ' new notes ', notesSeen: 'old' });
    expect(res.status).toBe(200);
    expect(saveNote).toHaveBeenLastCalledWith({
      p_call_id: CALL,
      p_fields: { notes: ' new notes ', notes_seen: 'old' },
    });
    expect(await res.json()).toEqual({
      disposition: 'call_back',
      notes: 'new notes',
      notesUpdatedAt: '2026-10-12T10:00:00Z',
    });
    res = await patch({ disposition: null, notesSeen: 'old' });
    expect(saveNote).toHaveBeenLastCalledWith({
      p_call_id: CALL,
      p_fields: { disposition: null },
    });
    expect((await res.json()).disposition).toBeNull();
  });

  it('tells an unseen note from an empty one', async () => {
    await patch({ notes: 'x' });
    expect(saveNote.mock.lastCall![0].p_fields).toEqual({ notes: 'x' });
    await patch({ notes: 'y', notesSeen: null });
    expect(saveNote.mock.lastCall![0].p_fields).toEqual({
      notes: 'y',
      notes_seen: null,
    });
  });

  it('answers a conflict with the stored note', async () => {
    const res = await patch({ notes: 'mine', notesSeen: 'older' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      conflict: true,
      notes: 'old',
    });
    expect(rls.tables.calls[0].notes).toBe('old');
  });

  it('validates before asking the database', async () => {
    for (const body of [
      {},
      { disposition: 'sold' },
      { notes: 42 },
      { notes: 'x'.repeat(4001) },
      { notes: 'x', notesSeen: 5 },
      { notesSeen: 'old' },
      ['notes'],
    ])
      expect((await patch(body)).status).toBe(400);
    expect((await patch({ notes: `  ${'x'.repeat(4000)}  ` })).status).toBe(
      200
    );
    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a call the caller cannot see', async () => {
    expect((await patch({ notes: 'x' }, HIDDEN)).status).toBe(404);
    saveNote.mockClear();
    expect((await patch({ notes: 'x' }, 'not-an-id')).status).toBe(404);
    expect(saveNote).not.toHaveBeenCalled();
  });

  it('maps the function’s refusals', async () => {
    rls.tables.calls[0].erased_at = '2026-10-11T00:00:00Z';
    let res = await patch({ disposition: 'interested' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This call was erased' });
    rls.rpcs.pbx_save_call_note = () => ({
      data: null,
      error: {
        code: '42501',
        message:
          'Only the person on the call or a team leader can record its outcome',
      },
    });
    res = await patch({ disposition: 'interested' });
    expect(res.status).toBe(403);
    rls.rpcs.pbx_save_call_note = () => ({
      data: null,
      error: { code: '22023', message: 'Unknown disposition' },
    });
    expect((await patch({ disposition: 'interested' })).status).toBe(400);
  });
});
