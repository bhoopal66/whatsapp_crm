import { describe, expect, it, vi } from 'vitest';

import { deleteMessageAndFiles } from '../api';
import { ChatError } from '../errors';
import { removeChatFiles, runChatFileSweep } from '../file-cleanup';

function admin(names: unknown, remove = vi.fn()) {
  const rpc = vi.fn().mockResolvedValue({ data: names, error: null });
  const from = vi.fn(() => ({ remove }));
  return { rpc, from, remove, client: { rpc, storage: { from } } as never };
}
const ok = async (p: string[]) => ({
  data: p.map((name) => ({ name })),
  error: null,
});

describe('runChatFileSweep', () => {
  it('lists at most 500 orphans and removes them from chat-files in batches of 100', async () => {
    const names = Array.from(
      { length: 205 },
      (_, i) => `account-a/channel-c/${i}-f`
    );
    const a = admin(names, vi.fn(ok));
    expect(await runChatFileSweep(a.client)).toEqual({
      found: 205,
      deleted: 205,
      failed: [],
    });
    expect(a.rpc).toHaveBeenCalledWith('chat_orphan_files', { p_limit: 500 });
    expect(a.from).toHaveBeenCalledWith('chat-files');
    expect(a.remove.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 5]);
  });

  it('does nothing when there is no orphan', async () => {
    const a = admin([]);
    expect(await runChatFileSweep(a.client)).toEqual({
      found: 0,
      deleted: 0,
      failed: [],
    });
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('throws when the listing fails', async () => {
    const a = admin(null);
    a.rpc.mockResolvedValue({
      data: null,
      error: { message: 'permission denied' },
    });
    await expect(runChatFileSweep(a.client)).rejects.toThrow(
      'permission denied'
    );
  });
});

describe('removeChatFiles', () => {
  it('retries a batch once and returns what is left', async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockImplementationOnce(ok)
      .mockResolvedValue({ data: null, error: { message: 'down' } });
    const paths = Array.from({ length: 150 }, (_, i) => `p${i}`);
    const r = await removeChatFiles(admin([], remove).client, paths);
    expect(r.deleted).toBe(100);
    expect(r.failed).toEqual(paths.slice(100));
    expect(remove).toHaveBeenCalledTimes(4);
  });

  it('never throws on a rejected remove', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('network'));
    expect(await removeChatFiles(admin([], remove).client, ['p'])).toEqual({
      deleted: 0,
      failed: ['p'],
    });
  });
});

describe('deleteMessageAndFiles', () => {
  it('posts to the delete route', async () => {
    const f = vi.fn().mockResolvedValue(Response.json({ files: 0 }));
    await deleteMessageAndFiles('m-1', f);
    expect(f).toHaveBeenCalledWith('/api/chat/messages/m-1/delete', {
      method: 'POST',
    });
  });

  it('turns a refusal into a ChatError with the server key', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: 'no', key: 'notAuthor' }, { status: 403 })
      );
    const err = await deleteMessageAndFiles('m-1', f).catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code: 'FORBIDDEN', key: 'notAuthor' });
  });
});
