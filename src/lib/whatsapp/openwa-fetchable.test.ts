import { describe, expect, it } from 'vitest';

import { assertGatewayFetchableUrl } from './openwa-api';

const base = 'http://192.168.1.5:8000';

describe('assertGatewayFetchableUrl', () => {
  it('lets our own Storage through, public or signed (321), even over http on a LAN', async () => {
    for (const link of [
      `${base}/storage/v1/object/public/chat-media/account-1/x.jpg`,
      `${base}/storage/v1/object/sign/chat-media/account-1/x.jpg?token=t`,
    ])
      await expect(
        assertGatewayFetchableUrl(link, { publicStorageBase: base }),
        link
      ).resolves.toBeUndefined();
  });

  it('refuses an encoded escape from the storage prefix, and plain http elsewhere', async () => {
    await expect(
      assertGatewayFetchableUrl(
        `${base}/storage/v1/object/sign/chat-media/..%2f..%2fauth/v1/x`,
        { publicStorageBase: base }
      )
    ).rejects.toThrow(/refused/);
    await expect(
      assertGatewayFetchableUrl('http://other.example/x.jpg', {
        publicStorageBase: base,
      })
    ).rejects.toThrow(/refused/);
  });
});
