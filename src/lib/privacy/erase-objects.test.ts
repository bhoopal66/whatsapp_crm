import { describe, expect, it, vi } from 'vitest';

import { deleteErasedObjects, objectPath } from './erase-objects';

const CHAT =
  'https://x.example/storage/v1/object/public/chat-media/account-1/inbound/a.jpg';

describe('deleteErasedObjects', () => {
  it('resolves chat-media URLs and skips foreign links', () => {
    expect(objectPath({ bucket: 'chat-media', url: CHAT })).toEqual({
      bucket: 'chat-media',
      path: 'account-1/inbound/a.jpg',
    });
    expect(
      objectPath({ bucket: 'chat-media', url: 'https://gate.whapi.cloud/m/1' })
    ).toBeNull();
  });

  it('deletes per bucket and reports the failures as remaining', async () => {
    const remove = vi.fn(async (paths: string[]) =>
      paths[0]?.startsWith('rec')
        ? { error: { message: 'nope' } }
        : { error: null }
    );
    const storage = { from: vi.fn(() => ({ remove })) };
    const out = await deleteErasedObjects(storage, [
      { bucket: 'call-recordings', path: 'rec/1.wav' },
      { bucket: 'deal-files', path: 'd/1.pdf' },
      { bucket: 'chat-media', url: CHAT },
      { bucket: 'chat-media', url: CHAT },
      { bucket: 'chat-media', url: 'https://gate.whapi.cloud/m/1' },
    ]);
    expect(out).toEqual({
      deleted: 2,
      skipped: 1,
      remaining: [{ bucket: 'call-recordings', path: 'rec/1.wav' }],
    });
    expect(storage.from).toHaveBeenCalledWith('chat-media');
  });

  it('never throws', async () => {
    const storage = {
      from: () => ({
        remove: async () => {
          throw new Error('down');
        },
      }),
    };
    const out = await deleteErasedObjects(storage, [
      { bucket: 'deal-files', path: 'x' },
    ]);
    expect(out.remaining).toHaveLength(1);
  });
});
