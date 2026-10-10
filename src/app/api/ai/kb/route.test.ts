import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  readXlsxSheets: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/contacts/read-xlsx', () => ({
  readXlsxSheets: mocks.readXlsxSheets,
}));

import { GET } from './route';
import { PATCH } from './[id]/route';
import { POST } from './import/route';

/** A chainable query builder that records its calls and resolves `result`. */
function query(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'update', 'delete']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { builder, calls };
}

const params = { params: Promise.resolve({ id: 'e1' }) };

describe('GET /api/ai/kb', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives a member entries and counts but no import history', async () => {
    const entries = query({
      data: [{ audience: 'existing_client', status: 'approved' }],
      error: null,
    });
    const from = vi.fn(() => entries.builder);
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      role: 'agent',
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.imports).toEqual([]);
    expect(body.summary.existing_client.approved).toBe(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(entries.calls).toContainEqual(['eq', ['account_id', 'a1']]);
  });

  it('gives an admin the last five imports', async () => {
    const entries = query({ data: [], error: null });
    const imports = query({ data: [{ id: 'i1' }], error: null });
    const from = vi.fn((t: string) =>
      t === 'kb_imports' ? imports.builder : entries.builder
    );
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      role: 'admin',
    });
    const body = await (await GET()).json();
    expect(body.imports).toEqual([{ id: 'i1' }]);
    expect(imports.calls).toContainEqual(['limit', [5]]);
  });
});

describe('PATCH /api/ai/kb/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the approved-usable CHECK to a plain 400', async () => {
    const q = query({
      data: null,
      error: {
        code: '23514',
        message: 'violates check constraint "kb_entries_approved_usable"',
      },
    });
    mocks.requireRole.mockResolvedValue({
      supabase: { from: () => q.builder },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(
      new Request('http://x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved' }),
      }),
      params
    );
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "An answer that is empty or still says [TO CONFIRM] can't be approved"
    );
    expect(q.calls).toContainEqual(['update', [{ status: 'approved' }]]);
    expect(q.calls).toContainEqual(['eq', ['account_id', 'a1']]);
  });

  it('rejects an invalid body before writing', async () => {
    const from = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(
      new Request('http://x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'live' }),
      }),
      params
    );
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/kb/import', () => {
  beforeEach(() => vi.clearAllMocks());

  function upload(name: string) {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2])], name));
    return new Request('http://x', { method: 'POST', body: form });
  }

  it('answers 400 when no sheet looks like the knowledge base', async () => {
    const rpc = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc },
      accountId: 'a1',
      userId: 'u1',
    });
    mocks.readXlsxSheets.mockResolvedValue([
      { name: 'Notes', rows: [['hello']] },
    ]);
    const res = await POST(upload('kb.xlsx'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No Knowledge_Base sheet found');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a non-xlsx file', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: vi.fn() },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await POST(upload('kb.csv'));
    expect(res.status).toBe(415);
  });

  it('imports the parsed sheet as the caller and returns the counts', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { inserted: 1, updated: 0, unchanged: 0, skipped: 0, approved: 1 },
      error: null,
    });
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc },
      accountId: 'a1',
      userId: 'u1',
    });
    mocks.readXlsxSheets.mockResolvedValue([
      {
        name: 'Knowledge_Base',
        rows: [
          ['ID', 'Audience', 'Question', 'Bot answer', 'Status'],
          ['pc-1', 'Prospective client', 'Fees?', 'Zero.', 'Approved'],
        ],
      },
    ]);
    const res = await POST(upload('kb.xlsx'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.inserted).toBe(1);
    expect(Array.isArray(body.issues)).toBe(true);
    const args = rpc.mock.calls[0][1];
    expect(rpc.mock.calls[0][0]).toBe('kb_import');
    expect(args.p_account_id).toBe('a1');
    expect(args.p_file_name).toBe('kb.xlsx');
    expect(args.p_rows).toHaveLength(1);
  });
});
