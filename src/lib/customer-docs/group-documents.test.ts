import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GroupCustomerDocument } from '@/lib/submission-groups/inbound';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';

import { FILING_COPY_TIMEOUT_MS, type FilingCopyDeps } from './filing-copy';
import { groupDocumentFiler } from './group-documents';

const doc: GroupCustomerDocument = {
  accountId: 'acct-1',
  contactId: 'contact-1',
  groupId: 'sg-1',
  groupMessageId: 77,
  waMessageId: 'wamid-1',
  kind: 'document',
  media: {
    id: 'media-1',
    link: 'https://gate.whapi.cloud/media/media-1',
    mime_type: 'application/pdf',
    filename: 'salary.pdf',
    file_size: 2048,
  },
  caption: 'my salary',
  sentAt: '2026-10-16T10:00:00.000Z',
};

const channel: WhatsAppChannel = {
  id: 'cfg-1',
  accountId: 'acct-1',
  provider: 'whapi',
  label: null,
  phoneNumberId: 'CHANNEL-1',
  wabaId: null,
  accessToken: 'channel-token',
  appSecret: null,
  isPrimary: true,
  mirrorInboundMedia: false,
  status: 'connected',
  isPersonal: false,
  personalUserId: null,
};

const MIRRORED =
  'https://db.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/x.pdf';

function setup() {
  const rpc = vi.fn(async () => ({ data: 'TC-000009', error: null }));
  const storage = { from: vi.fn() };
  const mirror = vi.fn<FilingCopyDeps['mirror']>(async () => MIRRORED);
  const getMediaUrl = vi.fn<FilingCopyDeps['getMediaUrl']>();
  const download = vi.fn<FilingCopyDeps['download']>();
  const channelOf = vi.fn(() => channel);
  const filer = groupDocumentFiler({
    admin: { rpc, storage } as never,
    channel: channelOf,
    deps: { mirror, getMediaUrl, download },
  });
  return { rpc, storage, mirror, getMediaUrl, channelOf, filer };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('groupDocumentFiler', () => {
  it('the hook only collects: no channel, no copy, no record', () => {
    const { rpc, mirror, getMediaUrl, channelOf, filer } = setup();

    expect(filer.hook(doc)).toBeUndefined();

    expect(channelOf).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
    expect(getMediaUrl).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('run() copies each document like the 1:1 path and records the copy, in order', async () => {
    const { rpc, storage, mirror, filer } = setup();
    filer.hook(doc);
    filer.hook({
      ...doc,
      groupMessageId: 78,
      waMessageId: 'wamid-2',
      kind: 'image',
      media: { id: 'media-2', link: 'https://gate.whapi.cloud/media/media-2' },
      caption: null,
    });

    await expect(filer.run()).resolves.toBeUndefined();

    expect(mirror).toHaveBeenCalledTimes(2);
    expect(mirror.mock.calls[0][0]).toMatchObject({
      storage,
      accountId: 'acct-1',
      mediaId: 'media-1',
      downloadUrl: 'https://gate.whapi.cloud/media/media-1',
      accessToken: 'channel-token',
      mimeType: 'application/pdf',
      fileSize: 2048,
      fileName: 'salary.pdf',
      messageTimestamp: 1792144800,
    });
    expect(mirror.mock.calls[1][0]).toMatchObject({ mediaId: 'media-2' });
    expect(rpc.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      {
        p_account_id: 'acct-1',
        p_contact_id: 'contact-1',
        p_source: 'submission_group',
        p_kind: 'document',
        p_media_url: MIRRORED,
        p_received_at: '2026-10-16T10:00:00.000Z',
        p_conversation_id: null,
        p_message_id: null,
        p_group_message_id: 77,
        p_mime: 'application/pdf',
        p_original_name: 'salary.pdf',
        p_caption: 'my salary',
      },
      expect.objectContaining({ p_group_message_id: 78, p_kind: 'image' }),
    ]);
  });

  it('run() files each document once', async () => {
    const { mirror, filer } = setup();
    filer.hook(doc);
    await filer.run();
    await filer.run();
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  it('resolves a document with an id and no link through getMediaUrl', async () => {
    const { rpc, mirror, getMediaUrl, filer } = setup();
    getMediaUrl.mockResolvedValue({
      url: 'https://gate.whapi.cloud/media/media-1',
      mimeType: 'application/pdf',
      fileSize: 2048,
    });
    filer.hook({ ...doc, media: { ...doc.media, link: null } });

    await filer.run();

    expect(getMediaUrl).toHaveBeenCalledWith({ channel, mediaId: 'media-1' });
    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'https://gate.whapi.cloud/media/media-1',
      })
    );
    expect(rpc).toHaveBeenCalledWith(
      'customer_documents_record',
      expect.objectContaining({ p_media_url: MIRRORED })
    );
  });

  it('a throwing copy never throws out of run(), and the next document is still filed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpc, mirror, filer } = setup();
    mirror.mockRejectedValueOnce(new Error('boom'));
    filer.hook(doc);
    filer.hook({ ...doc, groupMessageId: 78 });

    await expect(filer.run()).resolves.toBeUndefined();

    // The first document's Whapi /media/ link needs the token: never filed.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'customer_documents_record',
      expect.objectContaining({ p_group_message_id: 78 })
    );
    expect(log).toHaveBeenCalledWith(
      '[customer-docs] no durable copy for group message 77'
    );
  });

  it('a hanging copy is cut by the timeout and never throws out of run()', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpc, mirror, filer } = setup();
    mirror.mockImplementation(() => new Promise(() => {}));
    filer.hook(doc);

    const done = filer.run();
    await vi.advanceTimersByTimeAsync(FILING_COPY_TIMEOUT_MS);

    await expect(done).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a channel that cannot be built never throws out of run()', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rpc = vi.fn();
    const filer = groupDocumentFiler({
      admin: { rpc, storage: { from: vi.fn() } } as never,
      channel: () => {
        throw new Error('cannot decrypt');
      },
    });
    filer.hook(doc);

    await expect(filer.run()).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
