import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { GET, PUT } from './route';

const A1 = '00000000-0000-4000-8000-000000000001';
let fake: FakeDb;

// More numbers than one PostgREST read returns: deal-room calls can
// list past the 1,000 an admin may submit.
const numbers = Array.from({ length: 1200 }, (_, i) => String(100000 + i));

beforeEach(() => {
  vi.clearAllMocks();
  fake = createFakeDb({
    pbx_bank_numbers: numbers.map((number) => ({
      account_id: A1,
      number,
      bank_code: 'ADCB',
    })),
  });
  fake.capRows(1000);
  mocks.requireRole.mockResolvedValue({
    accountId: A1,
    userId: 'admin-1',
    role: 'admin',
    supabase: fake.db,
  });
});

describe("/api/pbx/bank-numbers past PostgREST's 1,000-row read cap", () => {
  it('lists every number', async () => {
    const listed = (await (await GET()).json()).bankNumbers as {
      number: string;
    }[];
    expect(listed.map((r) => r.number)).toEqual(numbers);
  });

  it('answers a save with every number left', async () => {
    const res = await PUT(
      new Request('https://crm.example.com/api/pbx/bank-numbers', {
        method: 'PUT',
        body: JSON.stringify({ bankNumbers: [], loaded: [numbers[0]] }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).bankNumbers).toHaveLength(numbers.length - 1);
  });
});
