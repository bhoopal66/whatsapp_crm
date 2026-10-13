import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.service,
}));

import { POST } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const CALL = '00000000-0000-4000-8000-000000000001';
const DEAL = '00000000-0000-4000-8000-000000000002';
const HIDDEN_DEAL = '00000000-0000-4000-8000-000000000003';
const CONTACT = '00000000-0000-4000-8000-000000000004';
let rls: FakeDb;
let service: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: A, userId: 'user-1', role, supabase: rls.db };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rls = createFakeDb({
    calls: [
      {
        id: CALL,
        account_id: A,
        recording_state: 'fetched',
        // The 12th in Dubai.
        started_at: '2026-10-11T21:00:00.000Z',
        contact_id: CONTACT,
        remote_number: '971501234567',
      },
    ],
    deals: [{ id: DEAL }],
    contacts: [{ id: CONTACT, name: 'Ahmed Ali', phone: '971501234567' }],
  });
  service = createFakeDb({ call_access_log: [], deal_files: [] });
  mocks.service = service.db;
  as('agent');
});

const post = (body: unknown, id = CALL) =>
  POST(
    new Request(`https://crm.example.com/api/pbx/calls/${id}/attach`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

describe('POST /api/pbx/calls/[id]/attach', () => {
  it('needs an agent', async () => {
    as('viewer');
    expect((await post({ dealId: DEAL })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('logs the attach and writes a reference row only', async () => {
    const res = await post({ dealId: DEAL });
    expect(res.status).toBe(200);
    const { fileId } = (await res.json()) as { fileId: string };
    expect(service.tables.call_access_log).toEqual([
      expect.objectContaining({
        call_id: CALL,
        account_id: A,
        user_id: 'user-1',
        action: 'attach',
      }),
    ]);
    expect(service.tables.deal_files).toEqual([
      {
        id: fileId,
        account_id: A,
        deal_id: DEAL,
        storage_path: null,
        name: 'Call recording 2026-10-12 Ahmed Ali',
        source: 'call_recording',
        ref_type: 'call',
        ref_id: CALL,
        created_by: 'user-1',
      },
    ]);
    // No audio is copied or signed, and the caller's client wrote nothing.
    expect(service.log.filter((l) => l.table.startsWith('storage:'))).toEqual(
      []
    );
    expect(rls.log.every((l) => l.op === 'select')).toBe(true);
  });

  it('names the file by the number when the contact is not visible', async () => {
    rls.tables.contacts = [];
    await post({ dealId: DEAL });
    expect(service.tables.deal_files[0].name).toBe(
      'Call recording 2026-10-12 971501234567'
    );
  });

  it('files nothing for a held recording', async () => {
    service.fail('call_access_log', 'insert', {
      code: '55000',
      message: 'This recording is not playable (held, erased or not fetched)',
    });
    const res = await post({ dealId: DEAL });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Recording held until the notice is confirmed',
      code: 'held',
    });
    expect(service.tables.deal_files).toEqual([]);
  });

  it('needs a call and a deal the caller can see', async () => {
    expect((await post({ dealId: HIDDEN_DEAL })).status).toBe(404);
    rls.tables.calls = [];
    expect((await post({ dealId: DEAL })).status).toBe(404);
    expect((await post({ dealId: 'x' })).status).toBe(400);
    expect(service.log).toEqual([]);
  });
});
