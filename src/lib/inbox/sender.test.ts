import { describe, it, expect } from 'vitest';

import type { Message } from '@/types';
import { memberNames, messageSender, type SenderContext } from './sender';

const ctx = (over: Partial<SenderContext> = {}): SenderContext => ({
  contactName: 'Aisha',
  currentUserId: 'me-1',
  names: memberNames([
    { user_id: 'me-1', full_name: 'Bhoopal', email: 'b@example.com' },
    { user_id: 'agent-2', full_name: 'Sara Ahmed', email: 's@example.com' },
  ]),
  namesLoaded: true,
  ...over,
});

const msg = (over: Partial<Message>): Message =>
  ({
    id: 'm-1',
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    status: 'sent',
    created_at: '2026-10-26T10:00:00.000Z',
    ...over,
  }) as Message;

describe('messageSender', () => {
  it('names the contact on a customer message', () => {
    expect(messageSender(msg({ sender_type: 'customer' }), ctx())).toEqual({
      kind: 'customer',
      name: 'Aisha',
    });
  });

  it('names the member who sent a reply, and marks the viewer’s own', () => {
    expect(messageSender(msg({ sender_id: 'agent-2' }), ctx())).toEqual({
      kind: 'person',
      name: 'Sara Ahmed',
      isMe: false,
    });
    expect(messageSender(msg({ sender_id: 'me-1' }), ctx())).toEqual({
      kind: 'person',
      name: 'Bhoopal',
      isMe: true,
    });
  });

  it('credits an optimistic bubble to the viewer, who is sending it', () => {
    expect(messageSender(msg({ id: 'temp-1700000000000' }), ctx())).toEqual({
      kind: 'person',
      name: 'Bhoopal',
      isMe: true,
    });
  });

  it('tells the AI reply from the other bot sends', () => {
    expect(
      messageSender(msg({ sender_type: 'bot', ai_generated: true }), ctx())
    ).toEqual({ kind: 'ai' });
    expect(messageSender(msg({ sender_type: 'bot' }), ctx())).toEqual({
      kind: 'bot',
    });
  });

  it('names nobody for an agent row with no sender (API, Compass, old replies)', () => {
    expect(messageSender(msg({ sender_id: undefined }), ctx())).toEqual({
      kind: 'team',
    });
  });

  it('waits for the member list before calling a sender unknown', () => {
    const loading = ctx({ names: new Map(), namesLoaded: false });
    expect(messageSender(msg({ sender_id: 'agent-2' }), loading)).toEqual({
      kind: 'pending',
    });
    expect(messageSender(msg({ sender_id: 'gone-9' }), ctx())).toEqual({
      kind: 'person',
      name: null,
      isMe: false,
    });
  });
});

describe('memberNames', () => {
  it('uses the full name, else the email, and skips a member with neither', () => {
    const names = memberNames([
      { user_id: 'a', full_name: '  Omar  ', email: 'o@example.com' },
      { user_id: 'b', full_name: ' ', email: 'nadia@example.com' },
      { user_id: 'c', full_name: null, email: null },
    ]);
    expect([...names]).toEqual([
      ['a', 'Omar'],
      ['b', 'nadia@example.com'],
    ]);
  });
});
