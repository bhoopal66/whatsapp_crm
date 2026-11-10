import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  results: {} as Record<string, unknown>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));

const ID = '11111111-1111-4111-8111-111111111111';

/** The caller's RLS client: every chain resolves to `m.results[table]`. */
const supabase = {
  from(table: string) {
    const q: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'order', 'limit']) {
      q[op] = (...args: unknown[]) => {
        m.calls.push({ table, op, args });
        return q;
      };
    }
    q.maybeSingle = async () => m.results[table];
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve(m.results[table]).then(ok, bad);
    return q;
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.calls = [];
  m.getCurrentAccount.mockResolvedValue({
    supabase,
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.results = {
    contacts: { data: { id: ID, account_id: 'acct-1' }, error: null },
    customer_doc_folders: {
      data: {
        ref: 'TC-000123',
        created_at: '2026-11-01T10:00:00Z',
        nas_created_at: '2026-11-01T10:01:00Z',
      },
      error: null,
    },
    customer_documents: {
      data: [
        {
          id: 'd1',
          kind: 'document',
          mime: 'application/pdf',
          original_name: 'passport.pdf',
          caption: null,
          nas_name: '2026-11-01 passport.pdf',
          media_url: 'https://gw.example/abc',
          received_at: '2026-11-01T10:00:00Z',
          status: 'stored',
          source: 'chat',
          size_bytes: 2048,
        },
      ],
      error: null,
      count: 7,
    },
  };
});

import { GET } from './route';

const get = (q = '', id = ID) =>
  GET(new Request(`http://x/api/contacts/${id}/documents${q}`), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/contacts/[id]/documents', () => {
  it('is 400 for an id that is not a uuid', async () => {
    const res = await get('', 'nope');
    expect(res.status).toBe(400);
    expect(m.calls).toEqual([]);
  });

  it('is 404 when the caller cannot read the contact, before any document read', async () => {
    m.results.contacts = { data: null, error: null };
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
    expect(m.calls.some((c) => c.table === 'customer_documents')).toBe(false);
  });

  it('is 404 for a contact of another account', async () => {
    m.results.contacts = {
      data: { id: ID, account_id: 'acct-2' },
      error: null,
    };
    expect((await get()).status).toBe(404);
  });

  it('answers the folder and the shaped documents, newest first, capped at 200', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folder: {
        ref: 'TC-000123',
        createdAt: '2026-11-01T10:00:00Z',
        onNas: true,
      },
      documents: [
        {
          id: 'd1',
          kind: 'document',
          name: '2026-11-01 passport.pdf',
          mime: 'application/pdf',
          sizeBytes: 2048,
          receivedAt: '2026-11-01T10:00:00Z',
          status: 'stored',
          source: 'chat',
          url: null,
        },
      ],
    });
    const docs = m.calls.filter((c) => c.table === 'customer_documents');
    expect(docs).toContainEqual({
      table: 'customer_documents',
      op: 'eq',
      args: ['contact_id', ID],
    });
    expect(docs).toContainEqual({
      table: 'customer_documents',
      op: 'order',
      args: ['received_at', { ascending: false }],
    });
    expect(docs).toContainEqual({
      table: 'customer_documents',
      op: 'limit',
      args: [200],
    });
  });

  it('answers a null folder when the customer has none yet', async () => {
    m.results.customer_doc_folders = { data: null, error: null };
    m.results.customer_documents = { data: [], error: null };
    expect(await (await get()).json()).toEqual({ folder: null, documents: [] });
  });

  it('summary=1 answers the folder and an exact head count only', async () => {
    const res = await get('?summary=1');
    expect(await res.json()).toEqual({
      folder: {
        ref: 'TC-000123',
        createdAt: '2026-11-01T10:00:00Z',
        onNas: true,
      },
      count: 7,
    });
    expect(m.calls).toContainEqual({
      table: 'customer_documents',
      op: 'select',
      args: ['id', { count: 'exact', head: true }],
    });
  });

  it('is 500 when a read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.results.customer_documents = { data: null, error: { code: 'XX000' } };
    expect((await get()).status).toBe(500);
  });
});
