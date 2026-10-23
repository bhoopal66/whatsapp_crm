import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), db: null as unknown }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.db,
}));

import { GET, PUT } from './route';
import { GET as GET_SETTINGS, PUT as PUT_SETTINGS } from '../settings/route';
import { GET as GET_BANKS, PUT as PUT_BANKS } from '../bank-numbers/route';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const [A1, A2, A3] = [id(1), id(2), id(3)];
let fake: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createFakeDb(
    {
      pbx_connections: [{ id: 'c1', account_id: A1, created_at: '1' }],
      pbx_did_routes: [
        { id: 'r1', connection_id: 'c1', did_number: '111', account_id: A2 },
        { id: 'r2', connection_id: 'c1', did_number: '222', account_id: A3 },
        { id: 'r3', connection_id: 'c1', did_number: '333', account_id: A1 },
      ],
      pbx_bank_numbers: [{ account_id: A1, number: '0501', bank_code: 'OLD' }],
    },
    {
      my_workspaces: () => ({
        data: [
          { account_id: A1, name: 'One', role: 'admin', deactivated: false },
          { account_id: A2, name: 'Two', role: 'owner', deactivated: false },
          { account_id: A3, name: 'Three', role: 'admin', deactivated: true },
        ],
        error: null,
      }),
    }
  );
  mocks.db = fake.db;
  mocks.requireRole.mockResolvedValue({
    accountId: A1,
    userId: 'admin-1',
    role: 'admin',
    supabase: fake.db,
  });
});

const req = (body: unknown) =>
  new Request('https://crm.example.com/api/pbx/x', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
const dids = () =>
  fake.tables.pbx_did_routes
    .map(
      (r) =>
        `${r.did_number}:${r.account_id === A1 ? 1 : r.account_id === A2 ? 2 : 3}`
    )
    .sort();

describe('/api/pbx/routes', () => {
  it('requires an admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await GET()).status).toBe(403);
    expect((await PUT(req({ routes: [] }))).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('lists the routes and the workspaces the caller may route to', async () => {
    const body = await (await GET()).json();
    expect(body.routes).toHaveLength(3);
    expect(body.workspaces).toEqual([
      { accountId: A1, name: 'One' },
      { accountId: A2, name: 'Two' },
    ]);
  });

  it('validates numbers, duplicates and workspace ids', async () => {
    for (const routes of [
      [{ didNumber: 'abc', accountId: A1 }],
      [
        { didNumber: '+971 4 111', accountId: A1 },
        { didNumber: '9714111', accountId: A2 },
      ],
      [{ didNumber: '444', accountId: 'acct' }],
    ])
      expect((await PUT(req({ routes }))).status).toBe(400);
    expect((await PUT(req([]))).status).toBe(400);
    expect(dids()).toEqual(['111:2', '222:3', '333:1']);
  });

  it('replaces the list; an untouched route to another workspace survives', async () => {
    const res = await PUT(
      req({
        routes: [
          { didNumber: '+1 11', nameOnPbx: ' Sales ', accountId: A1 },
          { didNumber: '222', accountId: A3 },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(dids()).toEqual(['111:1', '222:3']);
    expect(
      fake.tables.pbx_did_routes.find((r) => r.did_number === '111')!
        .name_on_pbx
    ).toBe('Sales');
  });

  it('refuses to point a number at a workspace the caller does not administer', async () => {
    const res = await PUT(
      req({ routes: [{ didNumber: '111', accountId: A3 }] })
    );
    expect(res.status).toBe(403);
    expect(dids()).toEqual(['111:2', '222:3', '333:1']);
  });
});

describe('/api/pbx/settings', () => {
  it('answers the defaults, validates and saves a partial update', async () => {
    expect((await (await GET_SETTINGS()).json()).settings).toMatchObject({
      announcementRequired: true,
      excludeBankNumbers: true,
      retentionDays: null,
      missedCallDueMinutes: 30,
    });
    for (const bad of [
      { retentionDays: 0 },
      { retentionDays: 3651 },
      { retentionDays: 1.5 },
      { missedCallDueMinutes: 0 },
      { missedCallDueMinutes: 1441 },
      { mandatoryDisposition: 'yes' },
      {},
    ])
      expect((await PUT_SETTINGS(req(bad))).status).toBe(400);
    const res = await PUT_SETTINGS(
      req({
        retentionDays: 365,
        confirmRetentionDays: 365,
        missedCallDueMinutes: 1440,
      })
    );
    expect((await res.json()).settings).toMatchObject({
      retentionDays: 365,
      missedCallDueMinutes: 1440,
    });
    expect(fake.tables.pbx_settings).toEqual([
      expect.objectContaining({ account_id: A1, retention_days: 365 }),
    ]);
    await PUT_SETTINGS(req({ retentionDays: null }));
    expect(fake.tables.pbx_settings[0]).toMatchObject({
      retention_days: null,
      missed_call_due_minutes: 1440,
    });
  });

  it('requires an admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await PUT_SETTINGS(req({ retentionDays: 30 }))).status).toBe(403);
  });
});

describe('/api/pbx/bank-numbers', () => {
  const banks = () =>
    fake.tables.pbx_bank_numbers
      .map((r) => `${r.number}:${r.bank_code}`)
      .sort();

  it('saves digits-only numbers and deletes the ones removed', async () => {
    const res = await PUT_BANKS(
      req({
        bankNumbers: [{ number: '+971 50 123', bankCode: ' ADCB ' }],
        loaded: ['0501'],
      })
    );
    expect((await res.json()).bankNumbers).toEqual([
      { number: '97150123', bankCode: 'ADCB' },
    ]);
    expect((await (await GET_BANKS()).json()).bankNumbers).toHaveLength(1);
  });

  it('keeps a number listed after the screen loaded', async () => {
    // A deal-room call lists a bank officer's number (deal-rooms/call.ts)
    // while an admin's screen still shows only 0501.
    fake.tables.pbx_bank_numbers.push({
      account_id: A1,
      number: '0509',
      bank_code: 'ENBD',
    });
    const res = await PUT_BANKS(
      req({
        bankNumbers: [
          { number: '0501', bankCode: 'OLD' },
          { number: '0777', bankCode: 'FAB' },
        ],
        loaded: ['0501'],
      })
    );
    expect(res.status).toBe(200);
    expect(banks()).toEqual(['0501:OLD', '0509:ENBD', '0777:FAB']);
  });

  it('deletes a number the admin removed, and only that', async () => {
    fake.tables.pbx_bank_numbers.push(
      { account_id: A1, number: '0509', bank_code: 'ENBD' },
      { account_id: A2, number: '0501', bank_code: 'OTHER' }
    );
    const res = await PUT_BANKS(req({ bankNumbers: [], loaded: ['0501'] }));
    expect((await res.json()).bankNumbers).toEqual([
      { number: '0509', bankCode: 'ENBD' },
    ]);
    expect(banks()).toEqual(['0501:OTHER', '0509:ENBD']);
  });

  it('refuses a save without the numbers the screen loaded', async () => {
    for (const loaded of [undefined, '0501', ['0501', '12']])
      expect(
        (
          await PUT_BANKS(
            req({ bankNumbers: [{ number: '0777', bankCode: 'A' }], loaded })
          )
        ).status
      ).toBe(400);
    expect(banks()).toEqual(['0501:OLD']);
  });

  it('caps what the admin submits, not what the screen loaded', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => String(100000 + i));
    const over = await PUT_BANKS(
      req({
        bankNumbers: many(1001).map((number) => ({ number, bankCode: 'A' })),
        loaded: [],
      })
    );
    expect(over.status).toBe(400);
    // Trimming a list deal-room calls grew past the cap still saves.
    const trimmed = await PUT_BANKS(
      req({
        bankNumbers: [{ number: '0501', bankCode: 'OLD' }],
        loaded: ['0501', ...many(1200)],
      })
    );
    expect(trimmed.status).toBe(200);
    expect(banks()).toEqual(['0501:OLD']);
  });

  it('deletes a long removal list in chunks', async () => {
    const many = Array.from({ length: 450 }, (_, i) => String(100000 + i));
    fake.tables.pbx_bank_numbers.push(
      ...many.map((number) => ({ account_id: A1, number, bank_code: 'A' }))
    );
    const res = await PUT_BANKS(
      req({ bankNumbers: [{ number: '0501', bankCode: 'OLD' }], loaded: many })
    );
    expect(res.status).toBe(200);
    expect(banks()).toEqual(['0501:OLD']);
    // 200 numbers per IN list, so the URL stays short.
    expect(
      fake.log.filter(
        (l) => l.table === 'pbx_bank_numbers' && l.op === 'delete'
      )
    ).toHaveLength(3);
  });

  it('refuses duplicates, short numbers and empty codes', async () => {
    for (const bankNumbers of [
      [
        { number: '0501', bankCode: 'A' },
        { number: '05-01', bankCode: 'B' },
      ],
      [{ number: '12', bankCode: 'A' }],
      [{ number: '0502', bankCode: ' ' }],
    ])
      expect((await PUT_BANKS(req({ bankNumbers, loaded: [] }))).status).toBe(
        400
      );
    expect(fake.tables.pbx_bank_numbers).toHaveLength(1);
  });
});
