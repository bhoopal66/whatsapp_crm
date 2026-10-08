import { describe, expect, it } from 'vitest';

import { conversationPatcher, patchIfSameConversation } from './patch-active';

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

describe('conversationPatcher', () => {
  // React's setters, over plain variables: each updater runs against
  // the state as it is when it lands, not as it was when made.
  function page(list: Chat[], active: Chat | null) {
    const state = { list, active };
    const patch = conversationPatcher<Chat>(
      (update) => {
        state.list = update(state.list);
      },
      (update) => {
        state.active = update(state.active);
      }
    );
    return { state, patch };
  }

  it('patches the list row and the open chat when it is the saved chat', () => {
    const a: Chat = { id: 'conv-a', chat_tag_id: null };
    const { state, patch } = page([a], a);
    patch('conv-a', { chat_tag_id: 't-int' });
    expect(state.list[0].chat_tag_id).toBe('t-int');
    expect(state.active?.chat_tag_id).toBe('t-int');
  });

  it('never patches a chat opened after the handler was made', () => {
    const a: Chat = { id: 'conv-a', chat_tag_id: null };
    const b: Chat = { id: 'conv-b', chat_tag_id: 't-new' };
    // Built while chat A was open; the agent opens B before A's save lands.
    const { state, patch } = page([a, b], a);
    state.active = b;
    patch('conv-a', { chat_tag_id: 't-int', assigned_agent_id: 'agent-1' });
    expect(state.active).toBe(b);
    expect(state.list[0]).toEqual({
      id: 'conv-a',
      chat_tag_id: 't-int',
      assigned_agent_id: 'agent-1',
    });
    expect(state.list[1]).toBe(b);
  });
});
