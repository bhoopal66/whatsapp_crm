import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import {
  closeForward,
  forwardDialogKey,
  forwardMessage,
  type ForwardEntry,
} from './forward-entry';

function entry(over: Partial<ForwardEntry> & { messageId?: string } = {}) {
  const { messageId = 'm1', ...rest } = over;
  return {
    id: 1,
    conversationId: 'A',
    message: { id: messageId } as Message,
    open: true,
    ...rest,
  };
}

describe('forwardDialogKey', () => {
  it('differs per message and per chat, so picks never carry over', () => {
    const keys = [
      forwardDialogKey(entry(), 'A'),
      forwardDialogKey(entry({ messageId: 'm2' }), 'A'),
      forwardDialogKey(entry(), 'B'),
      forwardDialogKey(entry({ conversationId: 'B' }), 'B'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('holds while the dialog closes, so it can animate out', () => {
    const open = entry();
    expect(forwardDialogKey(closeForward(open, 1), 'A')).toBe(
      forwardDialogKey(open, 'A')
    );
  });
});

describe('forwardMessage', () => {
  it('shows the message only in its own chat, while open', () => {
    expect(forwardMessage(entry(), 'A')?.id).toBe('m1');
    expect(forwardMessage(entry(), 'B')).toBeNull();
    expect(forwardMessage(entry({ open: false }), 'A')).toBeNull();
    expect(forwardMessage(null, 'A')).toBeNull();
  });
});

describe('closeForward', () => {
  it('closes its own opening', () => {
    expect(closeForward(entry(), 1)?.open).toBe(false);
  });

  it('leaves one opened since alone, even of the same message', () => {
    const later = entry({ id: 2 });
    expect(closeForward(later, 1)).toBe(later);
    expect(closeForward(null, 1)).toBeNull();
  });
});
