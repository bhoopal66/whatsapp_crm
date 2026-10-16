import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  get: vi.fn(),
  accessSet: vi.fn(),
  accessRemove: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({
    get: mocks.get,
    accessSet: mocks.accessSet,
    accessRemove: mocks.accessRemove,
  }),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { SubmissionGroupDbError } from '@/lib/submission-groups/store';

import { DELETE, PUT } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const U = '44444444-4444-4444-8444-444444444444';
const params = { params: Promise.resolve({ id: G }) };
const put = (body: unknown) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params
  );
const del = (qs: string) =>
  DELETE(new Request(`http://x/${qs}`, { method: 'DELETE' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.requireRole.mockResolvedValue({
    userId: 'admin-1',
    accountId: 'acct-1',
    role: 'admin',
  });
  mocks.get.mockResolvedValue({ id: G, accountId: 'acct-1' });
  mocks.accessSet.mockResolvedValue(undefined);
  mocks.accessRemove.mockResolvedValue(true);
});

describe('PUT access', () => {
  it('sets the label as the calling admin', async () => {
    const res = await put({ user_id: U, label: 'coordinator' });
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.accessSet).toHaveBeenCalledWith(
      G,
      U,
      'coordinator',
      'admin-1'
    );
  });

  it("answers 404 for another account's group and writes nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await put({ user_id: U, label: 'agent' })).status).toBe(404);
    expect(mocks.accessSet).not.toHaveBeenCalled();
  });

  it('rejects a bad user id or label with 400', async () => {
    expect((await put({ user_id: 'x', label: 'agent' })).status).toBe(400);
    expect((await put({ user_id: U, label: 'owner' })).status).toBe(400);
    expect(mocks.accessSet).not.toHaveBeenCalled();
  });

  it('answers 403 below admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    expect((await put({ user_id: U, label: 'agent' })).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('answers 409 on an ended group (55000)', async () => {
    mocks.accessSet.mockRejectedValue(
      new SubmissionGroupDbError('sg_access_set: not ACTIVE', '55000')
    );
    const res = await put({ user_id: U, label: 'agent' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This group has ended');
  });

  it('answers 422 when the access guard refuses the person', async () => {
    mocks.accessSet.mockRejectedValue(
      new SubmissionGroupDbError('sg_access_set: only a live agent', '23514')
    );
    expect((await put({ user_id: U, label: 'agent' })).status).toBe(422);
  });

  it('answers a generic 500 on any other failure', async () => {
    mocks.accessSet.mockRejectedValue(
      new SubmissionGroupDbError('sg_access_set: boom', 'XX000')
    );
    const res = await put({ user_id: U, label: 'agent' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain('boom');
  });
});

describe('DELETE access', () => {
  it('closes the person’s row', async () => {
    const res = await del(`?user_id=${U}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(mocks.accessRemove).toHaveBeenCalledWith(G, U);
  });

  it('rejects a missing user_id with 400', async () => {
    expect((await del('')).status).toBe(400);
    expect(mocks.accessRemove).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's group and writes nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await del(`?user_id=${U}`)).status).toBe(404);
    expect(mocks.accessRemove).not.toHaveBeenCalled();
  });

  it('answers 409 on an ended group', async () => {
    mocks.accessRemove.mockRejectedValue(
      new SubmissionGroupDbError('sg_access_remove: not ACTIVE', '55000')
    );
    expect((await del(`?user_id=${U}`)).status).toBe(409);
  });
});
