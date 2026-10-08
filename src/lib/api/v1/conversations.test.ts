import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation, Message } from '@/types';
import {
  chatTagLookup,
  loadChatTagLookup,
  serializeConversation,
  serializeMessage,
} from './conversations';

const tags = chatTagLookup([
  { id: 'interested', name: 'Interested', color: '#16a34a', parent_id: null },
  { id: 'adcb', name: 'ADCB', color: '#2563eb', parent_id: 'interested' },
  { id: 'new', name: 'New customer', color: '#f59e0b', parent_id: null },
  { id: 'walk-in', name: 'Walk-in', color: '#64748b', parent_id: 'new' },
]);

function convWith(
  chat_tag_id: string | null,
  chat_sub_tag_id: string | null
): Conversation {
  return {
    id: 'conv1',
    contact_id: 'c1',
    status: 'open',
    unread_count: 0,
    created_at: 'a',
    updated_at: 'b',
    chat_tag_id,
    chat_sub_tag_id,
  } as unknown as Conversation;
}

describe('serializeConversation', () => {
  it('projects public fields + nested contact and drops internals', () => {
    const conv = {
      id: 'conv1',
      user_id: 'internal-user',
      account_id: 'internal-acct',
      contact_id: 'c1',
      status: 'open',
      last_message_text: 'hi',
      last_message_at: '2026-01-01T00:00:00Z',
      unread_count: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      contact: {
        id: 'c1',
        account_id: 'internal-acct',
        phone: '+1',
        name: 'Jane',
        opted_out_at: '2026-09-01T00:00:00Z',
        // A stray embed from an older select still never reaches the wire.
        tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      },
    } as unknown as Conversation;

    const out = serializeConversation(conv, tags);
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('account_id');
    expect(out.contact).not.toHaveProperty('account_id');
    expect(out.contact?.tags).toEqual([]);
    expect(out.contact?.opted_out_at).toBe('2026-09-01T00:00:00Z');
    expect(out.unread_count).toBe(2);
    expect(out.chat_tag).toBeNull();
    expect(out.chat_sub_tag).toBeNull();
  });

  it('nulls opted_out_at on a contact that never opted out', () => {
    const conv = {
      ...convWith(null, null),
      contact: { id: 'c1', phone: '+1' },
    } as unknown as Conversation;
    expect(serializeConversation(conv, tags).contact?.opted_out_at).toBeNull();
  });

  it('names a main tag with no sub-tag', () => {
    const out = serializeConversation(convWith('new', null), tags);
    expect(out.chat_tag).toEqual({
      id: 'new',
      name: 'New customer',
      color: '#f59e0b',
    });
    expect(out.chat_sub_tag).toBeNull();
  });

  it('names a main tag and its own sub-tag', () => {
    const out = serializeConversation(convWith('interested', 'adcb'), tags);
    expect(out.chat_tag).toEqual({
      id: 'interested',
      name: 'Interested',
      color: '#16a34a',
    });
    expect(out.chat_sub_tag).toEqual({
      id: 'adcb',
      name: 'ADCB',
      color: '#2563eb',
    });
    expect(out.chat_tag).not.toHaveProperty('parent_id');
  });

  it('drops a sub-tag that belongs to another main tag', () => {
    const out = serializeConversation(convWith('interested', 'walk-in'), tags);
    expect(out.chat_tag?.id).toBe('interested');
    expect(out.chat_sub_tag).toBeNull();
  });

  it('resolves unknown ids to null', () => {
    const unknownMain = serializeConversation(convWith('gone', 'adcb'), tags);
    expect(unknownMain.chat_tag).toBeNull();
    expect(unknownMain.chat_sub_tag).toBeNull();

    const unknownSub = serializeConversation(
      convWith('interested', 'gone'),
      tags
    );
    expect(unknownSub.chat_tag?.id).toBe('interested');
    expect(unknownSub.chat_sub_tag).toBeNull();
  });

  it('does not show a sub-tag id stored as the main tag', () => {
    const out = serializeConversation(convWith('adcb', null), tags);
    expect(out.chat_tag).toBeNull();
  });
});

describe('loadChatTagLookup', () => {
  function fakeDb(result: { data: unknown; error: unknown }) {
    const eq = vi.fn(async () => result);
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return { db: { from } as unknown as SupabaseClient, from, select, eq };
  }

  it('reads the account’s chat tags once', async () => {
    const { db, from, select, eq } = fakeDb({
      data: [{ id: 'new', name: 'New', color: '#000', parent_id: null }],
      error: null,
    });
    const lookup = await loadChatTagLookup(db, 'acct-1', [
      { chat_tag_id: 'new' },
      { chat_tag_id: null },
      { chat_tag_id: 'new' },
    ]);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('chat_tags');
    expect(select).toHaveBeenCalledWith('id, name, color, parent_id');
    expect(eq).toHaveBeenCalledWith('account_id', 'acct-1');
    expect(lookup.get('new')?.name).toBe('New');
  });

  it('skips the read when no conversation carries a tag', async () => {
    const { db, from } = fakeDb({ data: [], error: null });
    const lookup = await loadChatTagLookup(db, 'acct-1', [
      { chat_tag_id: null },
    ]);
    expect(from).not.toHaveBeenCalled();
    expect(lookup.size).toBe(0);
  });

  it('fails with an internal error when the read fails', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      loadChatTagLookup(db, 'acct-1', [{ chat_tag_id: 'new' }])
    ).rejects.toMatchObject({ code: 'internal', status: 500 });
  });
});

describe('serializeMessage', () => {
  it('maps message_id → whatsapp_message_id and derives direction', () => {
    const inbound = {
      id: 'm1',
      conversation_id: 'conv1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.123',
      status: 'delivered',
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as Message;
    const outMsg = serializeMessage(inbound);
    expect(outMsg.direction).toBe('inbound');
    expect(outMsg.whatsapp_message_id).toBe('wamid.123');
    expect(outMsg).not.toHaveProperty('message_id');

    const agent = { ...inbound, sender_type: 'agent' } as unknown as Message;
    expect(serializeMessage(agent).direction).toBe('outbound');
  });
});
