import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';

import {
  bankErrorResponse,
  canCreateBankWorkspace,
  loadBankPost,
  loadBankThread,
  loadBankWorkspace,
  optionalUuid,
  requiredText,
} from './bank-http';
import {
  BankWorkspaceRefusedError,
  type BankWorkspace,
  type BankWsPost,
  type BankWsThread,
} from './bank-workspaces';
import { BankDashboardRefusedError } from './dashboard';
import { CaseHttpError } from './http';
import { CaseRefusedError, CaseStoreError } from './store';

const WS = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222221';
const T2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333331';
const P2 = '33333333-3333-4333-8333-333333333332';
const ctx = { accountId: 'acct-1', userId: 'u-me' };

const ws = (id = WS) => ({ bankWsId: id }) as BankWorkspace;
const thread = (id: string) => ({ threadId: id }) as BankWsThread;
const post = (id: string) => ({ postId: id }) as BankWsPost;

function fakeStore() {
  return {
    list: vi.fn(async () => [ws()]),
    threads: vi.fn(async () => [thread(T1), thread(T2)]),
    posts: vi.fn(async (t: string) => (t === T2 ? [post(P2)] : [post(P1)])),
  };
}

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CaseHttpError ? e.status : e;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('loadBankWorkspace', () => {
  it("answers the workspace from the caller's active-account list", async () => {
    const store = fakeStore();
    await expect(loadBankWorkspace(store, ctx, WS)).resolves.toEqual(ws());
    expect(store.list).toHaveBeenCalledWith('u-me', 'acct-1');
  });

  it('answers 404 for a workspace not in the list, and a non-uuid id', async () => {
    const store = fakeStore();
    store.list.mockResolvedValue([ws(T1)]);
    expect(await status(loadBankWorkspace(store, ctx, WS))).toBe(404);
    expect(await status(loadBankWorkspace(store, ctx, 'nope'))).toBe(404);
  });
});

describe('loadBankThread', () => {
  it("answers one of the workspace's threads", async () => {
    const store = fakeStore();
    const got = await loadBankThread(store, ctx, WS, T2);
    expect(got.thread).toEqual(thread(T2));
    expect(store.threads).toHaveBeenCalledWith(WS, 'u-me');
  });

  it('answers 404 for a thread of another workspace', async () => {
    const store = fakeStore();
    store.threads.mockResolvedValue([thread(T1)]);
    expect(await status(loadBankThread(store, ctx, WS, T2))).toBe(404);
  });
});

describe('loadBankPost', () => {
  it("finds the post in one of the workspace's threads", async () => {
    const store = fakeStore();
    const got = await loadBankPost(store, ctx, WS, P2);
    expect(got.post).toEqual(post(P2));
    expect(got.thread).toEqual(thread(T2));
  });

  it("answers 404 for a post in none of the workspace's threads", async () => {
    const store = fakeStore();
    store.threads.mockResolvedValue([thread(T1)]);
    expect(await status(loadBankPost(store, ctx, WS, P2))).toBe(404);
    expect(await status(loadBankPost(store, ctx, WS, 'x'))).toBe(404);
  });
});

describe('canCreateBankWorkspace', () => {
  it('is owners and admins only', () => {
    expect(canCreateBankWorkspace('owner')).toBe(true);
    expect(canCreateBankWorkspace('admin')).toBe(true);
    expect(canCreateBankWorkspace('team_leader')).toBe(false);
    expect(canCreateBankWorkspace('agent')).toBe(false);
    expect(canCreateBankWorkspace('bank_guest')).toBe(false);
  });
});

describe('body parsing', () => {
  it('requiredText trims and enforces 1..max', () => {
    expect(requiredText('  hi  ', 'body', 5)).toBe('hi');
    expect(() => requiredText('   ', 'body', 5)).toThrow(CaseHttpError);
    expect(() => requiredText('x'.repeat(6), 'body', 5)).toThrow(CaseHttpError);
    expect(() => requiredText(3, 'body', 5)).toThrow(CaseHttpError);
  });

  it('optionalUuid accepts absent, null and a uuid only', () => {
    expect(optionalUuid(undefined, 'case_id')).toBeNull();
    expect(optionalUuid(null, 'case_id')).toBeNull();
    expect(optionalUuid(WS, 'case_id')).toBe(WS);
    expect(() => optionalUuid('abc', 'case_id')).toThrow(CaseHttpError);
  });
});

describe('bankErrorResponse', () => {
  async function res(err: unknown) {
    const r = bankErrorResponse(err);
    return { status: r.status, body: await r.json() };
  }

  it('maps refusals: NOT_ALLOWED 403, *_NOT_FOUND 404, the rest 422', async () => {
    expect(await res(new BankWorkspaceRefusedError('NOT_ALLOWED'))).toEqual({
      status: 403,
      body: { error: 'Not allowed', code: 'NOT_ALLOWED' },
    });
    for (const code of [
      'BANK_WS_NOT_FOUND',
      'THREAD_NOT_FOUND',
      'POST_NOT_FOUND',
      'CASE_NOT_FOUND',
    ] as const)
      expect((await res(new BankWorkspaceRefusedError(code))).status).toBe(404);
    for (const code of [
      'BODY_INVALID',
      'ALREADY_MARKED',
      'TEMPLATE_NOT_FOUND',
      'BANK_UNKNOWN',
    ] as const) {
      const r = await res(new BankWorkspaceRefusedError(code));
      expect(r.status).toBe(422);
      expect(r.body.code).toBe(code);
    }
    expect(
      (await res(new BankDashboardRefusedError('BANK_WS_NOT_FOUND'))).status
    ).toBe(404);
  });

  it('passes everything else to caseErrorResponse, logging no message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await res(new CaseHttpError(400, 'bad'))).status).toBe(400);
    expect((await res(new CaseRefusedError('CASE_CLOSED'))).status).toBe(422);
    expect((await res(new ForbiddenError())).status).toBe(403);
    expect(
      (await res(new CaseStoreError('bank_ws_post_add', '23514'))).status
    ).toBe(500);
    expect((await res(new Error('secret post text'))).status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});
