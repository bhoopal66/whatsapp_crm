import { describe, expect, it } from 'vitest';

import { patchIfSameConversation } from './patch-active';

interface Chat {
  id: string;
  chat_tag_id: string | null;
  assigned_agent_id?: string;
}

describe('patchIfSameConversation', () => {
  it('applies the patch to the chat it was saved for', () => {
    const prev: Chat = { id: 'conv-a', chat_tag_id: null };
    const next = patchIfSameConversation(prev, 'conv-a', {
      chat_tag_id: 't-int',
    });
    expect(next).toEqual({ id: 'conv-a', chat_tag_id: 't-int' });
    expect(prev.chat_tag_id).toBeNull();
  });

  it('leaves a different open chat untouched, as the same object', () => {
    // Chat A's save landing after the agent opened chat B.
    const prev: Chat = { id: 'conv-b', chat_tag_id: 't-new' };
    const next = patchIfSameConversation(prev, 'conv-a', {
      chat_tag_id: 't-int',
      assigned_agent_id: 'agent-1',
    });
    expect(next).toBe(prev);
    expect(next).toEqual({ id: 'conv-b', chat_tag_id: 't-new' });
  });

  it('keeps no open chat as none', () => {
    expect(
      patchIfSameConversation<Chat>(null, 'conv-a', { chat_tag_id: 't-int' })
    ).toBeNull();
  });
});
