import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { composerModeFor } from './composer-mode';
import { micTooSoon, MIC_AFTER_SEND_MS } from './composer-ui';
import { createNoteDrafts } from './note-drafts';
import { mayNeedServiceWindow, sendsOverMeta } from './service-window';
import { slashKeyAction } from './slash-quick-replies';

const source = (name: string) =>
  readFileSync(`src/components/inbox/${name}.tsx`, 'utf8');

describe('composer mode', () => {
  it('opens on Reply again after a Note was left in another chat', () => {
    const a = { conversationId: 'a', mode: 'note' as const };
    const b = composerModeFor(a, 'b');
    expect(b).toEqual({ conversationId: 'b', mode: 'reply' });
    expect(composerModeFor(b, 'a').mode).toBe('reply');
    expect(composerModeFor(composerModeFor(a, null), 'a').mode).toBe('reply');
  });

  it('keeps the choice, and the same state, while the chat stays open', () => {
    const a = { conversationId: 'a', mode: 'note' as const };
    expect(composerModeFor(a, 'a')).toBe(a);
  });

  it('is stored by the thread on every render, not only read', () => {
    expect(source('message-thread')).toContain(
      'if (openMode !== composerMode) setComposerMode(openMode);'
    );
  });
});

describe('parked notes', () => {
  const note = (text: string) => ({
    text,
    picked: [{ user_id: 'p', full_name: 'Pia' }],
  });

  it('come back for their own chat only, with the people picked', () => {
    const d = createNoteDrafts();
    d.write('u', 'a', note('ask @Pia'));
    expect(d.read('u', 'b')).toBeNull();
    expect(d.read('u', 'a')).toEqual(note('ask @Pia'));
  });

  it('are dropped when blank or cleared', () => {
    const d = createNoteDrafts();
    d.write('u', 'a', note('x'));
    d.write('u', 'a', note(' \n'));
    expect(d.read('u', 'a')).toBeNull();
    d.write('u', 'a', note('x'));
    d.clear('u', 'a');
    expect(d.read('u', 'a')).toBeNull();
  });

  it('empty when another user signs in, and hold nothing signed out', () => {
    const d = createNoteDrafts();
    d.write(null, 'a', note('x'));
    d.write('u', 'a', note('x'));
    expect(d.read(null, 'a')).toBeNull();
    expect(d.read('other', 'a')).toBeNull();
    expect(d.read('u', 'a')).toBeNull();
  });

  it('drop the oldest chat past the bound', () => {
    const d = createNoteDrafts(2);
    d.write('u', 'a', note('1'));
    d.write('u', 'b', note('2'));
    d.write('u', 'a', note('1!'));
    d.write('u', 'c', note('3'));
    expect(d.read('u', 'b')).toBeNull();
    expect(d.read('u', 'a')?.text).toBe('1!');
    expect(d.read('u', 'c')?.text).toBe('3');
  });

  it('return after a failed save, never over a newer note or login', () => {
    const d = createNoteDrafts();
    d.write('u', 'a', note('x'));
    d.clear('u', 'a');
    d.restore('u', 'a', note('x'));
    expect(d.read('u', 'a')?.text).toBe('x');
    d.restore('u', 'a', note('old'));
    expect(d.read('u', 'a')?.text).toBe('x');
    d.read('other', 'a');
    d.restore('u', 'a', note('x'));
    expect(d.read('other', 'a')).toBeNull();
  });

  it('are memory only, and used by the note box', () => {
    const lib = readFileSync('src/lib/inbox/note-drafts.ts', 'utf8');
    expect(lib).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const box = source('note-composer');
    expect(box).toContain('noteDrafts.read(userId, conversationId)');
    expect(box).toContain('noteDrafts.write(userId, conversationId');
    expect(source('message-composer')).not.toContain('note-drafts');
  });
});

describe('slashKeyAction', () => {
  const key = (k: string, shiftKey = false) => ({ key: k, shiftKey });

  it('holds Enter and Tab while loading', () => {
    const list = { loading: true, count: 0 };
    expect(slashKeyAction(key('Enter'), list)).toBe('swallow');
    expect(slashKeyAction(key('Tab'), list)).toBe('swallow');
    expect(slashKeyAction(key('Enter', true), list)).toBe('pass');
    expect(slashKeyAction(key('Escape'), list)).toBe('close');
  });

  it('does not send on Enter with no match', () => {
    const list = { loading: false, count: 0 };
    expect(slashKeyAction(key('Enter'), list)).toBe('swallow');
    expect(slashKeyAction(key('Enter', true), list)).toBe('pass');
    expect(slashKeyAction(key('Escape'), list)).toBe('close');
    expect(slashKeyAction(key('a'), list)).toBe('pass');
  });

  it('picks and moves with matches', () => {
    const list = { loading: false, count: 2 };
    expect(slashKeyAction(key('Enter'), list)).toBe('pick');
    expect(slashKeyAction(key('Tab'), list)).toBe('pick');
    expect(slashKeyAction(key('ArrowDown'), list)).toBe('down');
    expect(slashKeyAction(key('ArrowUp'), list)).toBe('up');
    expect(slashKeyAction(key('Enter', true), list)).toBe('pass');
  });

  it('is what the box asks, and a failed load closes the list', () => {
    const box = source('message-composer');
    expect(box).toContain(
      'slashKeyAction(e, { loading: slashLoading, count })'
    );
    expect(box).toContain('!(slashFailed && slashLoading)');
    expect(box).toContain('setSlashFailed(true)');
  });
});

describe('sendsOverMeta', () => {
  const numbers = [
    { id: 'meta', provider: 'meta', is_primary: true },
    { id: 'whapi', provider: 'whapi', is_primary: false },
  ];
  const at = '2026-11-22T12:00:00Z';
  const from = (channel_id: string | null, provider: string | null) => ({
    created_at: at,
    channel_id,
    provider,
  });

  it('obeys a pin to Meta, whatever the customer last wrote to', () => {
    const chat = { channel_id: 'whapi', send_channel_id: 'meta' };
    expect(sendsOverMeta(numbers, chat, from('whapi', 'whapi'))).toBe(true);
    expect(sendsOverMeta(numbers, chat, undefined)).toBe(true);
    const other = { channel_id: 'meta', send_channel_id: 'whapi' };
    expect(sendsOverMeta(numbers, other, from('meta', 'meta'))).toBe(false);
  });

  it('follows the last customer message, not the chat number', () => {
    const chat = { channel_id: 'meta', send_channel_id: null };
    expect(sendsOverMeta(numbers, chat, from('whapi', 'whapi'))).toBe(false);
    expect(sendsOverMeta(numbers, chat, from('meta', 'meta'))).toBe(true);
    expect(sendsOverMeta(numbers, chat, from('gone', 'meta'))).toBe(false);
  });

  it('uses the provider of an older row without a number', () => {
    const chat = { channel_id: 'whapi', send_channel_id: null };
    expect(sendsOverMeta(numbers, chat, from(null, 'meta'))).toBe(true);
    expect(sendsOverMeta(numbers, chat, from(null, 'whapi'))).toBe(false);
    expect(sendsOverMeta([numbers[1]], chat, from(null, 'meta'))).toBe(false);
  });

  it('never guesses from the primary number', () => {
    const chat = { channel_id: null, send_channel_id: null };
    expect(sendsOverMeta(numbers, chat, null)).toBe(false);
  });

  it('still covers a Compass-started Meta chat with no inbound', () => {
    const chat = { channel_id: 'meta', send_channel_id: null };
    expect(sendsOverMeta(numbers, chat, null)).toBe(true);
  });

  it('never covers a personal chat', () => {
    const chat = {
      personal_owner_id: 'u',
      channel_id: 'meta',
      send_channel_id: 'meta',
    };
    expect(sendsOverMeta(numbers, chat, null)).toBe(false);
    expect(mayNeedServiceWindow(numbers, chat)).toBe(false);
  });

  it('is false while anything is still loading', () => {
    const chat = { channel_id: 'meta', send_channel_id: null };
    expect(sendsOverMeta(null, chat, null)).toBe(false);
    expect(sendsOverMeta(numbers, chat, undefined)).toBe(false);
  });

  it('asks for the last message only where it can matter', () => {
    expect(mayNeedServiceWindow(numbers, {})).toBe(true);
    expect(mayNeedServiceWindow([numbers[1]], {})).toBe(false);
    expect(mayNeedServiceWindow(numbers, { send_channel_id: 'whapi' })).toBe(
      false
    );
  });

  it('is the rule behind both the block and the countdown', () => {
    expect(source('message-thread')).toMatch(
      /sendsOverMeta\(accountNumbers, conversation, lastCustomer\)\s*\? serviceWindowState/
    );
  });
});

describe('composer guards', () => {
  it('refuses interactive and library sends once the window closed', () => {
    const box = source('message-composer');
    expect(box).toMatch(
      /const sendInteractive = useCallback\(\(\) => \{\s*if \(refuseBlocked\(\)\) return;/
    );
    expect(box).toMatch(
      /onSend=\{\(note\) => \{\s*if \(refuseBlocked\(\)\) return;/
    );
  });

  it('ignores the mic right after a send, on a button of its own', () => {
    expect(micTooSoon(1000, 1000 + MIC_AFTER_SEND_MS - 1)).toBe(true);
    expect(micTooSoon(1000, 1000 + MIC_AFTER_SEND_MS)).toBe(false);
    const box = source('message-composer');
    expect(box).toContain('key="send"');
    expect(box).toContain('key="mic"');
    expect(box).toContain('micTooSoon(lastSentAtRef.current');
  });

  it('sends a voice note to the chat it was recorded in, and no other', () => {
    const box = source('message-composer');
    // Its own chat's send, captured when Send is pressed.
    expect(box).toContain(
      'const send = { deliver: onSendMedia, replyToId: replyTo?.id };'
    );
    expect(box).toContain('meta.send.deliver({');
    expect(box).toContain('if (parkedFor !== meta.owner) removeStaged(path);');
    // A recording never runs on under the next chat.
    expect(box).toContain(
      'useLayoutEffect(() => () => leaveTake(), [conversationId, leaveTake]);'
    );
    // Refused with Meta's window closed, and kept.
    expect(box).toMatch(
      /const sendRecording = useCallback\(\(\) => \{[\s\S]{0,120}if \(refuseBlocked\(\)\) \{\s*listenFirst\(\);\s*return;/
    );
    // Another login's kept recording is not offered.
    expect(box).toContain('unsentTake?.meta.owner === userId');
    const thread = source('message-thread');
    expect(thread).toContain(
      'if (conversationIdRef.current === conversationId) onNewMessage(message);'
    );
    expect(thread).toContain(
      'if (conversationIdRef.current === conversation.id) setReplyTo(null);'
    );
  });

  it('closes the header strip on a switch, an action, outside, Escape', () => {
    const header = source('thread-header');
    expect(header).toContain('if (actionsFor !== conversation.id)');
    expect(header).toContain('onClick={closeActions}');
    expect(header).toContain("addEventListener('pointerdown'");
    expect(header).toContain("'Escape'");
  });
});
