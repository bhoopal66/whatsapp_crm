import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GroupCustomerDocument } from '@/lib/submission-groups/inbound';
import type { MirrorInboundMediaArgs } from '@/lib/whatsapp/mirror-inbound-media';

import { groupCustomerDocumentHook } from './group-documents';

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

const MIRRORED =
  'https://db.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/x.pdf';

function setup(mirrored: string | null | Error) {
  const rpc = vi.fn(async () => ({ data: 'TC-000009', error: null }));
  const storage = { from: vi.fn() };
  const mirror = vi.fn<
    (args: MirrorInboundMediaArgs) => Promise<string | null>
  >(async () => {
    if (mirrored instanceof Error) throw mirrored;
    return mirrored;
  });
  const hook = groupCustomerDocumentHook({
    admin: { rpc, storage } as never,
    accessToken: () => 'channel-token',
    mirror,
  });
  return { rpc, storage, mirror, hook };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('groupCustomerDocumentHook', () => {
  it('mirrors like the 1:1 Whapi path, then records the mirrored URL', async () => {
    const { rpc, storage, mirror, hook } = setup(MIRRORED);

    await expect(hook(doc)).resolves.toBe('TC-000009');

    expect(mirror).toHaveBeenCalledWith({
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
    expect(rpc).toHaveBeenCalledWith('customer_documents_record', {
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
    });
  });

  it.each([
    ['fails', null],
    ['throws', new Error('boom')],
  ])(
    'records nothing and logs one id-only line when the mirror %s',
    async (_, result) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { rpc, hook } = setup(result);

      await expect(hook(doc)).resolves.toBeNull();

      expect(rpc).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        '[customer-docs] group media not mirrored for group message 77'
      );
    }
  );

  it('records nothing when the media has no link', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpc, mirror, hook } = setup(MIRRORED);

    await hook({ ...doc, media: { ...doc.media, link: null } });

    expect(mirror).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
