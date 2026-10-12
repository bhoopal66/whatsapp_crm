import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

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

import { ForbiddenError } from '@/lib/auth/account';
import { TASK_COLUMNS } from '@/lib/tasks/types';

import { GET, POST } from './route';

const ACCOUNT = 'account-1';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
const CONTACT = '22222222-2222-4222-8222-222222222222';

/** A chainable query builder that records its calls and resolves `result`. */
function query(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'insert']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.single = () => Promise.resolve(result);
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { builder, calls };
}

/** Signs the caller in with one builder per table. */
function signIn(tables: Record<string, ReturnType<typeof query>>) {
  const from = vi.fn((table: string) => tables[table].builder);
  mocks.requireRole.mockResolvedValue({
    supabase: { from },
    accountId: ACCOUNT,
    userId: USER,
    role: 'agent',
  });
  return from;
}

function post(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const ORDER = [
  ['order', ['status', { ascending: false }]],
  ['order', ['due_at', { ascending: true, nullsFirst: false }]],
  ['order', ['created_at', { ascending: false }]],
];

describe('GET /api/tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to the caller's open tasks, open first then soonest due", async () => {
    const tasks = query({ data: [{ id: ID }], error: null });
    signIn({ tasks });
    const res = await GET(new Request('http://x/api/tasks'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [{ id: ID }] });
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(tasks.calls).toEqual([
      ['select', [TASK_COLUMNS]],
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['assigned_to', USER]],
      ['eq', ['status', 'open']],
      ...ORDER,
      ['limit', [100]],
    ]);
  });

  it("filters a contact's tasks, every status", async () => {
    const tasks = query({ data: [], error: null });
    signIn({ tasks });
    await GET(
      new Request(
        `http://x/api/tasks?scope=contact&contactId=${CONTACT}&status=all&limit=20`
      )
    );
    expect(tasks.calls).toEqual([
      ['select', [TASK_COLUMNS]],
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['contact_id', CONTACT]],
      ...ORDER,
      ['limit', [20]],
    ]);
  });

  it("filters a chat's tasks by status", async () => {
    const tasks = query({ data: [], error: null });
    signIn({ tasks });
    await GET(
      new Request(
        `http://x/api/tasks?scope=conversation&conversationId=${ID}&status=done`
      )
    );
    expect(tasks.calls).toContainEqual(['eq', ['conversation_id', ID]]);
    expect(tasks.calls).toContainEqual(['eq', ['status', 'done']]);
  });

  it('leaves scope=all to RLS: only the account filter', async () => {
    const tasks = query({ data: [], error: null });
    signIn({ tasks });
    await GET(new Request('http://x/api/tasks?scope=all'));
    const eqs = tasks.calls.filter(([m]) => m === 'eq');
    expect(eqs).toEqual([
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['status', 'open']],
    ]);
  });

  it('refuses a bad query before reading', async () => {
    const from = signIn({});
    const res = await GET(new Request('http://x/api/tasks?scope=contact'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('contactId');
    expect(from).not.toHaveBeenCalled();
  });

  it('answers 500 on a database error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    signIn({
      tasks: query({ data: null, error: { code: '57014', message: 'x' } }),
    });
    const res = await GET(new Request('http://x/api/tasks'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load tasks' });
  });

  it('passes a role refusal through', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('No'));
    const res = await GET(new Request('http://x/api/tasks'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('needs an agent, and assigns the caller when assignedTo is absent', async () => {
    const tasks = query({ data: { id: ID }, error: null });
    signIn({ tasks });
    const res = await POST(post({ title: 'Call back', contactId: CONTACT }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ task: { id: ID } });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(tasks.calls).toEqual([
      [
        'insert',
        [
          {
            title: 'Call back',
            note: null,
            kind: 'manual',
            source: 'manual',
            contact_id: CONTACT,
            conversation_id: null,
            deal_id: null,
            assigned_to: USER,
            due_at: null,
            account_id: ACCOUNT,
            created_by: USER,
          },
        ],
      ],
      ['select', [TASK_COLUMNS]],
    ]);
  });

  it('leaves the task unassigned when assignedTo is null', async () => {
    const tasks = query({ data: { id: ID }, error: null });
    signIn({ tasks });
    await POST(post({ title: 'x', assignedTo: null }));
    const [, [row]] = tasks.calls[0] as [string, [Record<string, unknown>]];
    expect(row.assigned_to).toBeNull();
  });

  it("takes the chat's contact when only the chat is linked", async () => {
    const conversations = query({ data: { contact_id: CONTACT }, error: null });
    const tasks = query({ data: { id: ID }, error: null });
    signIn({ conversations, tasks });
    const res = await POST(post({ title: 'x', conversationId: ID }));
    expect(res.status).toBe(201);
    expect(conversations.calls).toEqual([
      ['select', ['contact_id']],
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['id', ID]],
    ]);
    const [, [row]] = tasks.calls[0] as [string, [Record<string, unknown>]];
    expect(row).toMatchObject({ conversation_id: ID, contact_id: CONTACT });
  });

  it("answers 404 for a chat the caller can't see, creating nothing", async () => {
    const conversations = query({ data: null, error: null });
    const tasks = query({ data: { id: ID }, error: null });
    const from = signIn({ conversations, tasks });
    const res = await POST(post({ title: 'x', conversationId: ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
    expect(from).not.toHaveBeenCalledWith('tasks');
  });

  it('does not read the chat when the contact is given', async () => {
    const tasks = query({ data: { id: ID }, error: null });
    const from = signIn({ tasks });
    await POST(post({ title: 'x', conversationId: ID, contactId: CONTACT }));
    expect(from).not.toHaveBeenCalledWith('conversations');
  });

  it('refuses an invalid body before writing', async () => {
    const from = signIn({});
    const res = await POST(post({ title: '   ' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'title cannot be empty' });
    expect(from).not.toHaveBeenCalled();
  });

  it('maps an RLS refusal to 403 and a trigger refusal to 400 with its sentence', async () => {
    signIn({
      tasks: query({ data: null, error: { code: '42501', message: 'policy' } }),
    });
    let res = await POST(post({ title: 'x' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "You can't make that change to this task",
    });

    signIn({
      tasks: query({
        data: null,
        error: {
          code: '23514',
          message: 'That person cannot be assigned tasks',
        },
      }),
    });
    res = await POST(post({ title: 'x', assignedTo: ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'That person cannot be assigned tasks',
    });
  });
});
