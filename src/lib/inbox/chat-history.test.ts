import { describe, expect, it } from 'vitest';

import { chatPopAction, chatUrlWrite, isPushedChat } from './chat-history';

const phone = { twoPane: false, chatOpen: false, urlChat: null };

describe('chatUrlWrite', () => {
  it('adds an entry going from the list to a chat on a phone', () => {
    const write = chatUrlWrite({ ...phone, historyState: { __NA: true } });
    expect(write.method).toBe('pushState');
    expect(isPushedChat(write.state)).toBe(true);
  });

  it('replaces from chat to chat and keeps the mark', () => {
    const pushed = chatUrlWrite({ ...phone, historyState: null }).state;
    const write = chatUrlWrite({
      ...phone,
      chatOpen: true,
      urlChat: 'a',
      historyState: { __NA: true, ...pushed },
    });
    expect(write.method).toBe('replaceState');
    expect(isPushedChat(write.state)).toBe(true);
  });

  it('does not mark an entry the list did not add (a link to a chat)', () => {
    expect(
      chatUrlWrite({
        ...phone,
        chatOpen: true,
        urlChat: 'a',
        historyState: { __NA: true },
      })
    ).toEqual({ method: 'replaceState', state: null });
  });

  it('replaces a ?c= that never opened, rather than leave it behind Back', () => {
    expect(
      chatUrlWrite({ ...phone, urlChat: 'gone', historyState: null }).method
    ).toBe('replaceState');
  });

  it('never adds an entry side by side', () => {
    expect(
      chatUrlWrite({ ...phone, twoPane: true, historyState: null })
    ).toEqual({ method: 'replaceState', state: null });
  });
});

describe('isPushedChat', () => {
  it('reads only the mark', () => {
    for (const s of [null, undefined, 'x', {}, { __NA: true }]) {
      expect(isPushedChat(s)).toBe(false);
    }
  });
});

describe('chatPopAction', () => {
  const at = {
    twoPane: false,
    screenPath: '/team-inbox',
    path: '/team-inbox',
    urlChat: null,
    openId: 'a',
  };

  it('closes the chat when Back lands on the list', () => {
    expect(chatPopAction(at)).toEqual({ kind: 'close' });
  });

  it('closes a chat still on its way', () => {
    expect(chatPopAction({ ...at, openId: null })).toEqual({ kind: 'close' });
  });

  it('opens the chat the entry names', () => {
    expect(chatPopAction({ ...at, urlChat: 'b' })).toEqual({
      kind: 'open',
      id: 'b',
    });
  });

  it('leaves the chat the entry names alone when it is open', () => {
    expect(chatPopAction({ ...at, urlChat: 'a' })).toEqual({ kind: 'none' });
  });

  it('does nothing on the way to another screen, or side by side', () => {
    expect(chatPopAction({ ...at, path: '/dashboard' }).kind).toBe('none');
    expect(chatPopAction({ ...at, twoPane: true }).kind).toBe('none');
  });
});
