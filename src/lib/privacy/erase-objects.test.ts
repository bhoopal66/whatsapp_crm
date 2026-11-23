import { describe, expect, it, vi } from 'vitest';

import {
  deleteErasedObjects,
  objectPath,
  retryErasedObjects,
} from './erase-objects';

const CHAT =
  'https://x.example/storage/v1/object/public/chat-media/account-1/inbound/a.jpg';

describe('deleteErasedObjects', () => {
  it('resolves chat-media URLs and skips foreign links', () => {
    expect(objectPath('1', { bucket: 'chat-media', url: CHAT })).toEqual({
      bucket: 'chat-media',
      path: 'account-1/inbound/a.jpg',
    });
    expect(
      objectPath('1', {
        bucket: 'chat-media',
        url: 'https://gate.whapi.cloud/m/1',
      })
    ).toBeNull();
  });

  it('accepts the two case-files layouts, in that bucket only', () => {
    const id = '7a27ed59-3fb8-4148-a673-46bf28b14c5b';
    for (const path of [`cases/${id}/ab.pdf`, `intake/${id}/ab.pdf`]) {
      expect(objectPath('1', { bucket: 'case-files', path })).toEqual({
        bucket: 'case-files',
        path,
      });
      expect(objectPath('1', { bucket: 'chat-media', path })).toBeNull();
    }
    expect(
      objectPath('1', { bucket: 'case-files', path: `other/${id}/ab.pdf` })
    ).toBeNull();
  });

  it('deletes per bucket and reports the failures as remaining', async () => {
    const remove = vi.fn(async (paths: string[]) =>
      paths[0]?.startsWith('account-1/rec')
        ? { error: { message: 'nope' } }
        : { error: null }
    );
    const storage = { from: vi.fn(() => ({ remove })) };
    const out = await deleteErasedObjects(storage, '1', [
      { bucket: 'call-recordings', path: 'account-1/rec/1.wav' },
      { bucket: 'deal-files', path: 'account-1/d/1.pdf' },
      { bucket: 'chat-media', url: CHAT },
      { bucket: 'chat-media', url: CHAT },
      { bucket: 'chat-media', url: 'https://gate.whapi.cloud/m/1' },
    ]);
    expect(out).toEqual({
      deleted: 2,
      skipped: 1,
      remaining: [{ bucket: 'call-recordings', path: 'account-1/rec/1.wav' }],
    });
    expect(storage.from).toHaveBeenCalledWith('chat-media');
  });

  it('never removes a path outside the account (skipped, not remaining)', async () => {
    const remove = vi.fn(async () => ({ error: null }));
    const out = await deleteErasedObjects({ from: () => ({ remove }) }, '1', [
      { bucket: 'chat-media', url: CHAT.replace('account-1/', 'account-2/') },
      { bucket: 'chat-media', path: 'account-12/a.jpg' },
      { bucket: 'chat-media', path: '1/a.jpg' },
      { bucket: 'deal-files', path: 'account-1/../account-2/a.pdf' },
      { bucket: 'call-recordings', path: 'account-2/calls/a.wav' },
    ]);
    expect(out).toEqual({ deleted: 0, skipped: 5, remaining: [] });
    expect(remove).not.toHaveBeenCalled();
  });

  it('retries unrecorded erasures and records the result', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const remove = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async (fn: string) => ({
      data:
        fn === 'privacy_erase_objects_pending'
          ? [
              {
                account_id: '1',
                request_id: 7,
                objects: [{ bucket: 'deal-files', path: 'account-1/a' }],
              },
            ]
          : null,
      error: null,
    }));
    await retryErasedObjects({ rpc, storage: { from: () => ({ remove }) } });
    expect(remove).toHaveBeenCalledWith(['account-1/a']);
    expect(rpc).toHaveBeenLastCalledWith('privacy_erase_objects_settle', {
      p_request: 7,
      p_remaining: [],
    });
  });

  it('never throws', async () => {
    const storage = {
      from: () => ({
        remove: async () => {
          throw new Error('down');
        },
      }),
    };
    const out = await deleteErasedObjects(storage, '1', [
      { bucket: 'deal-files', path: 'account-1/x' },
    ]);
    expect(out.remaining).toHaveLength(1);
  });
});

describe('retryErasedObjects pages (282)', () => {
  it('takes page after page, and a list that fails again once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const A = '00000000-0000-4000-8000-000000000001';
    let queue = Array.from({ length: 12 }, (_, i) => i + 1);
    const settled: number[] = [];
    const left = await retryErasedObjects({
      storage: {
        from: () => ({
          // Request 3's file can never be deleted.
          remove: async (paths: string[]) => ({
            error: paths[0]!.endsWith('/3.jpg') ? 'no' : null,
          }),
        }),
      },
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'privacy_erase_objects_settle') {
          const id = Number(args!.p_request);
          settled.push(id);
          queue = queue.filter((x) => x !== id);
          if ((args!.p_remaining as unknown[]).length) queue.push(id);
          return { data: null, error: null };
        }
        return {
          data: queue.slice(0, Number(args!.p_limit)).map((id) => ({
            account_id: A,
            request_id: id,
            objects: [{ bucket: 'chat-media', path: `account-${A}/${id}.jpg` }],
          })),
          error: null,
        };
      },
    });
    expect(left).toBe(false);
    expect(settled).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(queue).toEqual([3]);
  });
});
