import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  customerDocumentKind,
  recordCustomerDocument,
  type CustomerDocumentInput,
} from './record';

const input: CustomerDocumentInput = {
  accountId: 'acct-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  messageRowId: 'row-1',
  source: 'chat',
  kind: 'document',
  mediaUrl: 'https://db.example.com/storage/v1/object/public/a.pdf',
  mime: 'application/pdf',
  originalName: 'salary-certificate.pdf',
  caption: 'my salary certificate',
  receivedAt: '2025-10-09T08:53:20.000Z',
};

type RpcReply = Promise<{ data: unknown; error: { message: string } | null }>;

function fakeAdmin(impl: () => RpcReply) {
  const rpc = vi.fn<(fn: string, args: unknown) => RpcReply>(impl);
  return { rpc, admin: { rpc } as never };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('customerDocumentKind', () => {
  it('files documents and photos', () => {
    expect(customerDocumentKind('document')).toBe('document');
    expect(customerDocumentKind('image')).toBe('image');
  });

  it('never files a sticker, though it is stored as an image', () => {
    expect(customerDocumentKind('sticker')).toBeNull();
  });

  it.each(['audio', 'voice', 'video', 'text', 'location', 'contacts'])(
    'never files %s',
    (type) => {
      expect(customerDocumentKind(type)).toBeNull();
    }
  );
});

describe('recordCustomerDocument', () => {
  it('calls the RPC with exactly the named args and returns the ref', async () => {
    const { rpc, admin } = fakeAdmin(async () => ({
      data: 'TC-000123',
      error: null,
    }));

    await expect(recordCustomerDocument(admin, input)).resolves.toBe(
      'TC-000123'
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('customer_documents_record', {
      p_account_id: 'acct-1',
      p_contact_id: 'contact-1',
      p_source: 'chat',
      p_kind: 'document',
      p_media_url: 'https://db.example.com/storage/v1/object/public/a.pdf',
      p_received_at: '2025-10-09T08:53:20.000Z',
      p_conversation_id: 'conv-1',
      p_message_id: 'row-1',
      p_mime: 'application/pdf',
      p_original_name: 'salary-certificate.pdf',
      p_caption: 'my salary certificate',
    });
  });

  it('passes absent optional fields as null', async () => {
    const { rpc, admin } = fakeAdmin(async () => ({
      data: 'TC-000123',
      error: null,
    }));

    await recordCustomerDocument(admin, {
      ...input,
      kind: 'image',
      mime: null,
      originalName: null,
      caption: '  ',
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_kind: 'image',
      p_mime: null,
      p_original_name: null,
      p_caption: null,
    });
  });

  it('swallows an RPC error with one log line naming only the row', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin(async () => ({
      data: null,
      error: { message: 'contact not found' },
    }));

    await expect(recordCustomerDocument(admin, input)).resolves.toBeNull();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[customer-docs] record failed for message row-1: contact not found'
    );
  });

  it('swallows a thrown rejection', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin(async () => {
      throw new Error('fetch failed');
    });

    await expect(recordCustomerDocument(admin, input)).resolves.toBeNull();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[customer-docs] record failed for message row-1: fetch failed'
    );
  });

  it.each([null, '', '   '])(
    'records nothing when the media URL is %j',
    async (mediaUrl) => {
      const { rpc, admin } = fakeAdmin(async () => ({
        data: 'TC-000123',
        error: null,
      }));

      await expect(
        recordCustomerDocument(admin, { ...input, mediaUrl })
      ).resolves.toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it('records nothing when the kind is null', async () => {
    const { rpc, admin } = fakeAdmin(async () => ({
      data: 'TC-000123',
      error: null,
    }));

    await expect(
      recordCustomerDocument(admin, { ...input, kind: null })
    ).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('recordCustomerDocument for a submission group', () => {
  const groupInput: CustomerDocumentInput = {
    source: 'submission_group',
    accountId: 'acct-1',
    contactId: 'contact-1',
    groupMessageId: 4321,
    kind: 'image',
    mediaUrl: 'https://db.example.com/storage/v1/object/public/p.jpg',
    mime: 'image/jpeg',
    originalName: null,
    caption: 'front of my ID',
    receivedAt: '2025-10-09T08:53:20.000Z',
  };

  it('sends the group message id and null chat ids', async () => {
    const { rpc, admin } = fakeAdmin(async () => ({
      data: 'TC-000124',
      error: null,
    }));

    await expect(recordCustomerDocument(admin, groupInput)).resolves.toBe(
      'TC-000124'
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]).toStrictEqual([
      'customer_documents_record',
      {
        p_account_id: 'acct-1',
        p_contact_id: 'contact-1',
        p_source: 'submission_group',
        p_kind: 'image',
        p_media_url: 'https://db.example.com/storage/v1/object/public/p.jpg',
        p_received_at: '2025-10-09T08:53:20.000Z',
        p_conversation_id: null,
        p_message_id: null,
        p_group_message_id: 4321,
        p_mime: 'image/jpeg',
        p_original_name: null,
        p_caption: 'front of my ID',
      },
    ]);
  });

  it('never sends a group message id on the chat path', async () => {
    const { rpc, admin } = fakeAdmin(async () => ({
      data: 'TC-000123',
      error: null,
    }));

    await recordCustomerDocument(admin, input);

    expect(Object.keys(rpc.mock.calls[0][1] as object)).not.toContain(
      'p_group_message_id'
    );
  });

  it('logs the group message id only when the RPC fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin(async () => ({
      data: null,
      error: { message: 'contact not found' },
    }));

    await expect(recordCustomerDocument(admin, groupInput)).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith(
      '[customer-docs] record failed for group message 4321: contact not found'
    );
  });
});
