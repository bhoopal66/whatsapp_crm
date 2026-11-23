import { afterEach, describe, expect, it, vi } from 'vitest';

import { BodyTooLargeError } from '@/lib/media/capped-body';
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';
import { mirrorInboundMedia } from './mirror-inbound-media';

afterEach(() => vi.restoreAllMocks());

describe('the mirror asks for at most what the bucket takes', () => {
  it('passes its limit and skips a file past it, saying so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upload = vi.fn();
    const download = vi.fn(async (args: { maxBytes: number }) => {
      throw new BodyTooLargeError(args.maxBytes + 1, args.maxBytes);
    });
    await expect(
      mirrorInboundMedia({
        storage: { from: () => ({ upload, getPublicUrl: vi.fn() }) } as never,
        accountId: 'a',
        mediaId: '1',
        downloadUrl: 'https://gate.whapi.cloud/media/1',
        accessToken: 't',
        download,
      })
    ).resolves.toBeNull();
    expect(download.mock.calls[0][0].maxBytes).toBe(MEDIA_MAX_BYTES);
    expect(upload).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/over the \d+-byte bucket limit/);
  });
});
