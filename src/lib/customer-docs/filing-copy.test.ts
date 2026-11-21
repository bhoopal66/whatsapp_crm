import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { WHAPI_BASE_URL } from '@/lib/whatsapp/whapi-api';

const h = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('./record', () => ({ recordCustomerDocument: h.record }));

import {
  fileWithDurableCopy,
  isCredentialFreeLink,
  isOwnStorageUrl,
  type FilingCopyDeps,
  type FilingMedia,
  type FilingRecordInput,
} from './filing-copy';

// ============================================================
// The NAS worker downloads a recorded URL with no credentials, so a
// customer document is filed with a copy in our own bucket, or with a
// link that needs none, or not at all.
// ============================================================

const STORED =
  'https://crm.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/x.pdf';
const LOOKASIDE =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
const S3 = 'https://s3.eu-central-1.wasabisys.com/in-files/1/x.pdf';

const channel: WhatsAppChannel = {
  id: 'ch-1',
  accountId: 'acct-1',
  provider: 'meta',
  label: null,
  phoneNumberId: 'pn-1',
  wabaId: 'waba-1',
  accessToken: 'token',
  appSecret: null,
  isPrimary: true,
  mirrorInboundMedia: false,
  status: 'connected',
  isPersonal: false,
  personalUserId: null,
};

const record: FilingRecordInput = {
  source: 'chat',
  accountId: 'acct-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  messageRowId: 'row-1',
  kind: 'document',
  mime: 'application/pdf',
  originalName: 'salary.pdf',
  caption: null,
  receivedAt: '2025-10-09T08:53:20.000Z',
};

const media: FilingMedia = {
  link: LOOKASIDE,
  id: 'media-1',
  objectId: 'media-1',
  mimeType: 'application/pdf',
  fileSize: 10,
  fileName: 'salary.pdf',
  messageTimestamp: '1760000000',
};

const storage = { from: vi.fn() };
const admin = { rpc: vi.fn(), storage };

let mirror: ReturnType<typeof vi.fn>;
let getMediaUrl: ReturnType<typeof vi.fn>;
let download: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.spyOn>;

function deps(extra: Partial<FilingCopyDeps> = {}): Partial<FilingCopyDeps> {
  return {
    mirror: mirror as unknown as FilingCopyDeps['mirror'],
    getMediaUrl: getMediaUrl as unknown as FilingCopyDeps['getMediaUrl'],
    download: download as unknown as FilingCopyDeps['download'],
    ...extra,
  };
}

function file(
  over: {
    media?: Partial<FilingMedia>;
    channel?: Partial<WhatsAppChannel>;
    deps?: Partial<FilingCopyDeps>;
  } = {}
) {
  return fileWithDurableCopy({
    admin,
    channel: () => ({ ...channel, ...over.channel }),
    media: { ...media, ...over.media },
    record,
    deps: deps(over.deps),
  });
}

beforeEach(() => {
  h.record.mockReset().mockResolvedValue('TC-000123');
  mirror = vi.fn().mockResolvedValue(STORED);
  getMediaUrl = vi.fn();
  download = vi.fn();
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
});

describe('isOwnStorageUrl', () => {
  it('matches the chat-media public path on any origin', () => {
    expect(isOwnStorageUrl(STORED)).toBe(true);
    expect(
      isOwnStorageUrl(
        'https://quick-tunnel.trycloudflare.com/storage/v1/object/public/chat-media/account-a/staged/y.jpg'
      )
    ).toBe(true);
  });

  it('refuses gateway links, other buckets and garbage', () => {
    expect(isOwnStorageUrl(LOOKASIDE)).toBe(false);
    expect(
      isOwnStorageUrl(
        'https://crm.example.com/storage/v1/object/public/chat-files/x.pdf'
      )
    ).toBe(false);
    expect(isOwnStorageUrl('not a url')).toBe(false);
  });
});

describe('isCredentialFreeLink', () => {
  it('refuses a Meta lookaside link', () => {
    expect(isCredentialFreeLink(LOOKASIDE, 'meta')).toBe(false);
  });

  it('refuses every Meta link, whatever its host: Cloud API media needs the token', () => {
    expect(isCredentialFreeLink(S3, 'meta')).toBe(false);
    expect(
      isCredentialFreeLink('https://graph.facebook.com/v21.0/media-1', 'meta')
    ).toBe(false);
  });

  it('refuses a Whapi /media/ link', () => {
    expect(isCredentialFreeLink(`${WHAPI_BASE_URL}/media/abc`, 'whapi')).toBe(
      false
    );
  });

  it('refuses anything on OpenWA', () => {
    expect(isCredentialFreeLink(S3, 'openwa')).toBe(false);
  });

  it('accepts a plain https storage link', () => {
    expect(isCredentialFreeLink(S3, 'whapi')).toBe(true);
  });

  it('refuses http and garbage', () => {
    expect(isCredentialFreeLink(S3.replace('https:', 'http:'), 'whapi')).toBe(
      false
    );
    expect(isCredentialFreeLink('nope', 'whapi')).toBe(false);
  });
});

describe('fileWithDurableCopy', () => {
  it('records the mirrored URL when the copy succeeds', async () => {
    // The recorded document comes back for the desk router (230).
    await expect(file()).resolves.toEqual({
      documentId: 'TC-000123',
      mediaUrl: STORED,
    });

    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        storage,
        accountId: 'acct-1',
        mediaId: 'media-1',
        downloadUrl: LOOKASIDE,
        accessToken: 'token',
        mimeType: 'application/pdf',
        fileSize: 10,
        fileName: 'salary.pdf',
        messageTimestamp: '1760000000',
      })
    );
    expect(h.record).toHaveBeenCalledWith(admin, {
      ...record,
      mediaUrl: STORED,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("downloads through the channel's own gateway client", async () => {
    await file();
    const args = mirror.mock.calls[0][0];
    await args.download({ downloadUrl: LOOKASIDE, token: 'x' });
    expect(download).toHaveBeenCalledWith({
      channel,
      downloadUrl: LOOKASIDE,
    });
  });

  it('records a credential-free link when the copy fails', async () => {
    mirror.mockResolvedValue(null);
    await file({ media: { link: S3 }, channel: { provider: 'whapi' } });

    expect(h.record).toHaveBeenCalledWith(admin, { ...record, mediaUrl: S3 });
    expect(log).not.toHaveBeenCalled();
  });

  it('records nothing and logs once when the copy fails on a Meta link', async () => {
    mirror.mockResolvedValue(null);
    await expect(file()).resolves.toBeNull();

    expect(h.record).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[customer-docs] no durable copy for message row-1'
    );
  });

  it('resolves a missing link through getMediaUrl, then copies it', async () => {
    getMediaUrl.mockResolvedValue({
      url: LOOKASIDE,
      mimeType: 'image/jpeg',
      fileSize: 42,
    });
    await file({ media: { link: null, mimeType: null, fileSize: null } });

    expect(getMediaUrl).toHaveBeenCalledWith({
      channel,
      mediaId: 'media-1',
    });
    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: LOOKASIDE,
        mimeType: 'image/jpeg',
        fileSize: 42,
      })
    );
    expect(h.record).toHaveBeenCalledWith(admin, {
      ...record,
      mediaUrl: STORED,
    });
  });

  it('a hanging copy is cut by the timeout, and nothing rejects unhandled', async () => {
    vi.useFakeTimers();
    let rejectCopy: (e: Error) => void = () => {};
    mirror.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectCopy = reject))
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const done = file({ deps: { timeoutMs: 1_000 } });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.record).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    // The copy that lost the race fails afterwards: nobody hears it.
    rejectCopy(new Error('socket hang up'));
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('a throwing record never throws out', async () => {
    h.record.mockRejectedValue(new Error('boom'));
    await expect(file()).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a throwing channel never throws out', async () => {
    await expect(
      fileWithDurableCopy({
        admin,
        channel: () => {
          throw new Error('cannot decrypt');
        },
        media,
        record,
        deps: deps(),
      })
    ).resolves.toBeNull();
    expect(mirror).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
});
