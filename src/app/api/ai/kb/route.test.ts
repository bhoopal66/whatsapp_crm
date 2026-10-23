import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  readXlsxSheets: vi.fn(),
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    requireRole: mocks.requireRole,
    ForbiddenError: actual.ForbiddenError,
    toErrorResponse: actual.toErrorResponse,
  };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/contacts/read-xlsx', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/contacts/read-xlsx')
  >('@/lib/contacts/read-xlsx');
  return {
    readXlsxSheets: mocks.readXlsxSheets,
    XlsxLimitError: actual.XlsxLimitError,
  };
});

import { ForbiddenError } from '@/lib/auth/account';
import { GET } from './route';
import { DELETE, PATCH } from './[id]/route';
import { POST } from './import/route';
import { XlsxLimitError } from '@/lib/contacts/read-xlsx';

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

const ID = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
const params = { params: Promise.resolve({ id: ID }) };

function patchRequest(body: unknown) {
  return new Request('http://x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

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
      patchRequest({ status: 'approved', version: 2 }),
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
      patchRequest({ status: 'live', version: 1 }),
      params
    );
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('updates only the version the dialog displayed, in the caller account', async () => {
    const q = query({ data: { id: ID, version: 4 }, error: null });
    const from = vi.fn(() => q.builder);
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(
      patchRequest({ status: 'approved', version: 3 }),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).entry).toEqual({ id: ID, version: 4 });
    expect(q.calls).toContainEqual(['eq', ['version', 3]]);
    expect(q.calls).toContainEqual(['eq', ['account_id', 'a1']]);
    expect(q.calls).toContainEqual(['eq', ['id', ID]]);
  });

  it('answers 409 when the row changed since the dialog opened', async () => {
    const update = query({ data: null, error: null });
    const reread = query({ data: { id: ID }, error: null });
    const from = vi
      .fn()
      .mockReturnValueOnce(update.builder)
      .mockReturnValueOnce(reread.builder);
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(
      patchRequest({ status: 'approved', version: 1 }),
      params
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'This answer changed since you opened it. Reload and review it again.'
    );
    expect(reread.calls).toContainEqual(['eq', ['account_id', 'a1']]);
    expect(reread.calls).toContainEqual(['eq', ['id', ID]]);
  });

  it("answers 404 when the row is gone or another account's", async () => {
    const update = query({ data: null, error: null });
    const reread = query({ data: null, error: null });
    const from = vi
      .fn()
      .mockReturnValueOnce(update.builder)
      .mockReturnValueOnce(reread.builder);
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(
      patchRequest({ status: 'approved', version: 1 }),
      params
    );
    expect(res.status).toBe(404);
  });

  it('requires the version', async () => {
    const from = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(patchRequest({ status: 'approved' }), params);
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('answers 400 for a non-UUID id', async () => {
    const from = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    const res = await PATCH(patchRequest({ status: 'approved', version: 1 }), {
      params: Promise.resolve({ id: 'e1' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid id' });
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses a non-admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    const res = await PATCH(
      patchRequest({ status: 'approved', version: 1 }),
      params
    );
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/ai/kb/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(result: { data: unknown; error: unknown }) {
    const q = query(result);
    const from = vi.fn(() => q.builder);
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      accountId: 'a1',
      userId: 'u1',
    });
    return { q, from };
  }
  const del = () => new Request('http://x', { method: 'DELETE' });

  it('deletes within the caller account', async () => {
    const { q } = setup({ data: [{ id: ID }], error: null });
    const res = await DELETE(del(), params);
    expect(res.status).toBe(200);
    expect(q.calls).toContainEqual(['delete', []]);
    expect(q.calls).toContainEqual(['eq', ['account_id', 'a1']]);
    expect(q.calls).toContainEqual(['eq', ['id', ID]]);
    expect(q.calls).toContainEqual(['select', ['id']]);
  });

  it('answers 404 when nothing was deleted', async () => {
    setup({ data: [], error: null });
    const res = await DELETE(del(), params);
    expect(res.status).toBe(404);
  });

  it('answers 400 for a non-UUID id', async () => {
    const { from } = setup({ data: [], error: null });
    const res = await DELETE(del(), { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid id' });
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses a non-admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    const res = await DELETE(del(), params);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(403);
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

  it('passes a workbook limit refusal through in the 400', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: vi.fn() },
      accountId: 'a1',
      userId: 'u1',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.readXlsxSheets.mockRejectedValue(
      new XlsxLimitError('The workbook has more than 50 sheets')
    );
    let res = await POST(upload('kb.xlsx'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      'The workbook has more than 50 sheets'
    );
    // Any other read error stays generic.
    mocks.readXlsxSheets.mockRejectedValue(new Error('Not a ZIP file'));
    res = await POST(upload('kb.xlsx'));
    expect((await res.json()).error).toBe(
      'The file could not be read as an .xlsx workbook.'
    );
  });

  it('refuses a non-admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    const res = await POST(upload('kb.xlsx'));
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(403);
    expect(mocks.readXlsxSheets).not.toHaveBeenCalled();
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

  it("lists the parser's issues, then the ones kb_import raised", async () => {
    const withdrawn = {
      row: 3,
      ref: 'PC-1',
      message: 'Answer changed without a Status column — needs approval again',
      skipped: false,
    };
    const rpc = vi.fn().mockResolvedValue({
      data: {
        inserted: 0,
        updated: 1,
        unchanged: 0,
        skipped: 1,
        approved: 0,
        issues: [withdrawn],
      },
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
          ['ID', 'Audience', 'Question', 'Bot answer'],
          ['pc-1', 'Prospective client', 'Fees?', 'Zero now.'],
          ['pc-2', 'Prospective client', '', 'No question.'],
        ],
      },
    ]);
    const body = await (await POST(upload('kb.xlsx'))).json();
    const parserIssues = rpc.mock.calls[0][1].p_issues;
    expect(parserIssues.length).toBeGreaterThan(0);
    expect(body.issues).toEqual([...parserIssues, withdrawn]);
  });
});
