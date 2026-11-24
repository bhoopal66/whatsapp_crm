import { beforeEach, describe, expect, it, vi } from 'vitest';

// A malformed id is nobody's: 404 (or 400 for a filter), never a 500.

const m = vi.hoisted(() => ({
  answer: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => {
    const chain: Record<string, unknown> = {};
    for (const k of ['select', 'update', 'delete', 'eq', 'is'])
      chain[k] = () => chain;
    chain.maybeSingle = async () => m.answer;
    return { accountId: 'acct-1', supabase: { from: () => chain } };
  },
}));

import { GET as broadcast } from './broadcasts/[id]/route';
import { GET as conversation } from './conversations/[id]/route';
import { GET as conversations } from './conversations/route';
import {
  DELETE as dropHook,
  GET as hook,
  PATCH as patchHook,
} from './webhooks/[id]/route';

const params = { params: Promise.resolve({ id: 'not-a-uuid' }) };
const req = (init?: RequestInit) => new Request('http://x/api/v1/y', init);
const patch = () =>
  req({ method: 'PATCH', body: JSON.stringify({ is_active: true }) });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a malformed id', () => {
  const calls: [string, () => Promise<Response>][] = [
    ['GET broadcasts/[id]', () => broadcast(req(), params)],
    ['GET conversations/[id]', () => conversation(req(), params)],
    ['GET webhooks/[id]', () => hook(req(), params)],
    ['PATCH webhooks/[id]', () => patchHook(patch(), params)],
    ['DELETE webhooks/[id]', () => dropHook(req(), params)],
  ];

  it.each(calls)('%s answers 404', async (_name, call) => {
    m.answer = { data: null, error: { code: '22P02' } };
    expect((await call()).status).toBe(404);
  });

  it.each(calls)('%s still answers 500 to a failed read', async (_n, call) => {
    m.answer = { data: null, error: { code: '57014' } };
    expect((await call()).status).toBe(500);
  });

  it('GET conversations?contact_id= answers 400', async () => {
    const res = await conversations(
      new Request('http://x/api/v1/conversations?contact_id=not-a-uuid')
    );
    expect(res.status).toBe(400);
  });
});
