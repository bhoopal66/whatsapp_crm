import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  existing: { data: null as unknown, error: null as unknown },
  deleted: { data: null as unknown, error: null as unknown },
  inUse: { data: false as unknown, error: null as unknown },
  rpc: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (...args: unknown[]) => {
      mocks.rpc(...args);
      return Promise.resolve(mocks.inUse);
    },
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          mocks.remove(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
  }),
}));

import { DELETE } from './route';

const ACCOUNT = '11111111-2222-4333-8444-555555555555';
const ENTRY = '22222222-3333-4444-8555-666666666666';
const PATH = `account-${ACCOUNT}/voice-library/${ENTRY}.ogg`;

// The caller's client: reads and deletes the row under 242's RLS.
const callerClient = {
  from() {
    const b: Record<string, unknown> = {};
    let deleting = false;
    b.select = () => b;
    b.eq = () => b;
    b.delete = () => {
      deleting = true;
      return b;
    };
    b.maybeSingle = () => Promise.resolve(mocks.existing);
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(deleting ? mocks.deleted : mocks.existing).then(resolve);
    return b;
  },
};

function del(id = ENTRY) {
  return DELETE(
    new Request(`http://localhost/api/voice-library/entries/${id}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    supabase: callerClient,
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
  mocks.existing = { data: { id: ENTRY, storage_path: PATH }, error: null };
  mocks.deleted = { data: [{ id: ENTRY }], error: null };
  mocks.inUse = { data: false, error: null };
});

describe('DELETE /api/voice-library/entries/[id]', () => {
  it('removes the audio when no message points at it', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('voice_library_audio_in_use', {
      p_account: ACCOUNT,
      p_path: PATH,
    });
    expect(mocks.remove).toHaveBeenCalledWith([PATH]);
  });

  it('keeps the audio a sent message still plays', async () => {
    mocks.inUse = { data: true, error: null };
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('keeps the audio when the check cannot run', async () => {
    mocks.inUse = { data: null, error: { message: 'timeout' } };
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('touches no audio when RLS refused the row delete', async () => {
    mocks.deleted = { data: [], error: null };
    const res = await del();
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('touches no audio for an entry the caller cannot see', async () => {
    mocks.existing = { data: null, error: null };
    const res = await del();
    expect(res.status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('needs no audio work for a personalised entry', async () => {
    mocks.existing = { data: { id: ENTRY, storage_path: null }, error: null };
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
