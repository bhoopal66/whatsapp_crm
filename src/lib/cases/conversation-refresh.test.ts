import { describe, expect, it, vi } from 'vitest';

import type { SgMessage } from '@/lib/submission-groups/ui';

import type { CaseConversation } from './case-tabs';
import {
  canRefresh,
  CONVERSATION_RETRY_MS,
  ConversationRefresh,
  mergeConversation,
  probeSince,
  type ConversationAnswer,
  type RefreshIo,
} from './conversation-refresh';

const msg = (n: number) =>
  ({
    id: `m${n}`,
    created_at: new Date(Date.UTC(2026, 10, 24, 9, n)).toISOString(),
  }) as SgMessage;
const convo = (
  from: number,
  to: number,
  over: Partial<CaseConversation> = {}
): CaseConversation => ({
  groupId: 'g-1',
  archived: false,
  waMode: 'group',
  truncated: false,
  messages: Array.from({ length: to - from + 1 }, (_, i) => msg(from + i)),
  ...over,
});
const ids = (c: CaseConversation) => c.messages.map((m) => m.id);

const io = (over: Partial<RefreshIo> = {}) => ({
  shown: convo(1, 3),
  probe: vi.fn(async () => true),
  read: vi.fn(async (): Promise<ConversationAnswer> => ({
    kind: 'ok',
    convo: convo(1, 4),
  })),
  active: () => true,
  show: vi.fn(),
  ...over,
});

describe('what is refreshed', () => {
  it('only an active group with a WhatsApp chat', () => {
    expect(canRefresh(convo(1, 1))).toBe(true);
    expect(canRefresh(null)).toBe(false);
    expect(canRefresh(convo(1, 1, { archived: true }))).toBe(false);
    expect(canRefresh(convo(1, 1, { groupId: null }))).toBe(false);
    expect(canRefresh(convo(1, 1, { waMode: 'none' }))).toBe(false);
  });

  it('probes from the newest message shown, or the epoch', () => {
    expect(probeSince(convo(1, 3))).toBe('2026-11-24T09:03:00.000Z');
    expect(probeSince(convo(1, 0))).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('mergeConversation', () => {
  it('keeps the older rows shown that the new window dropped', () => {
    const merged = mergeConversation(
      convo(1, 5),
      convo(3, 7, { truncated: true })
    );
    expect(ids(merged)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    // Everything there is was on screen already.
    expect(merged.truncated).toBe(false);
    expect(
      mergeConversation(convo(2, 5, { truncated: true }), convo(4, 8)).truncated
    ).toBe(true);
  });

  it('takes a window that does not meet the rows shown as it is', () => {
    const fresh = convo(10, 12, { truncated: true });
    expect(mergeConversation(convo(1, 5), fresh)).toBe(fresh);
    const empty = convo(1, 0);
    expect(mergeConversation(convo(1, 5), empty)).toBe(empty);
  });

  it('takes the rest of the answer from the fresh read', () => {
    expect(
      mergeConversation(convo(1, 3), convo(2, 4, { archived: true })).archived
    ).toBe(true);
  });
});

describe('ConversationRefresh.tick', () => {
  it('reads only when the probe says something changed', async () => {
    const quiet = io({ probe: vi.fn(async () => false) });
    const r = new ConversationRefresh();
    await r.tick(quiet);
    expect(quiet.read).not.toHaveBeenCalled();

    const changed = io();
    await r.tick(changed);
    expect(changed.probe).toHaveBeenCalledWith('2026-11-24T09:03:00.000Z');
    expect(changed.show).toHaveBeenCalledWith(convo(1, 4));
  });

  it('stops after NOT_READABLE, until a read that works', async () => {
    const r = new ConversationRefresh();
    const gone = io({
      read: vi.fn(async (): Promise<ConversationAnswer> => ({
        kind: 'notReadable',
      })),
    });
    await r.tick(gone);
    expect(gone.show).not.toHaveBeenCalled();
    await r.tick(gone);
    expect(gone.probe).toHaveBeenCalledTimes(1);
    expect(gone.read).toHaveBeenCalledTimes(1);

    r.settle(r.start(), true);
    const back = io();
    await r.tick(back);
    expect(back.show).toHaveBeenCalledTimes(1);
  });

  it('a failed probe changes nothing, and the next tick tries again', async () => {
    const r = new ConversationRefresh();
    const down = io({ probe: vi.fn(() => Promise.reject(new Error('x'))) });
    await r.tick(down);
    expect(down.read).not.toHaveBeenCalled();
    const ok = io();
    await r.tick(ok);
    expect(ok.show).toHaveBeenCalledTimes(1);
  });

  it('a failed read changes nothing and waits: it may have been audited', async () => {
    vi.useFakeTimers();
    try {
      const r = new ConversationRefresh();
      const failed = io({
        read: vi.fn(async (): Promise<ConversationAnswer> => ({
          kind: 'failed',
        })),
      });
      await r.tick(failed);
      expect(failed.show).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CONVERSATION_RETRY_MS - 1);
      const early = io();
      await r.tick(early);
      expect(early.probe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      const late = io();
      await r.tick(late);
      expect(late.show).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the person's own read that works ends the wait", async () => {
    const r = new ConversationRefresh();
    await r.tick(
      io({
        read: vi.fn(async (): Promise<ConversationAnswer> => ({
          kind: 'failed',
        })),
      })
    );
    r.settle(r.start(), true);
    const ok = io();
    await r.tick(ok);
    expect(ok.show).toHaveBeenCalledTimes(1);
  });

  it('never shows its answer over a read that started later', async () => {
    const r = new ConversationRefresh();
    const late = io({
      read: vi.fn(async (): Promise<ConversationAnswer> => {
        // The person's own send is read, and shown, meanwhile.
        expect(r.settle(r.start(), true)).toBe(true);
        return { kind: 'ok', convo: convo(1, 4) };
      }),
    });
    await r.tick(late);
    expect(late.show).not.toHaveBeenCalled();
  });

  it('an older NOT_READABLE does not stop ticks after a newer good read', async () => {
    const r = new ConversationRefresh();
    const late = io({
      read: vi.fn(async (): Promise<ConversationAnswer> => {
        r.settle(r.start(), true);
        return { kind: 'notReadable' };
      }),
    });
    await r.tick(late);
    const next = io();
    await r.tick(next);
    expect(next.show).toHaveBeenCalledTimes(1);
  });

  it('does not read when the tab went away or was read during the probe', async () => {
    const r = new ConversationRefresh();
    const hidden = io({ active: () => false });
    await r.tick(hidden);
    expect(hidden.read).not.toHaveBeenCalled();
    const sent = io({
      probe: vi.fn(async () => {
        r.settle(r.start(), true);
        return true;
      }),
    });
    await r.tick(sent);
    expect(sent.read).not.toHaveBeenCalled();
  });

  it('one tick at a time', async () => {
    const r = new ConversationRefresh();
    let answer: (changed: boolean) => void = () => {};
    const slow = io({
      probe: vi.fn(() => new Promise<boolean>((ok) => (answer = ok))),
    });
    const first = r.tick(slow);
    await r.tick(slow);
    expect(slow.probe).toHaveBeenCalledTimes(1);
    answer(false);
    await first;
  });

  it('shows an ended group, and leaves the tab alone when the group is gone', async () => {
    const r = new ConversationRefresh();
    const ended = io({
      read: async () => ({
        kind: 'ok',
        convo: convo(1, 3, { archived: true }),
      }),
    });
    await r.tick(ended);
    expect(ended.show).toHaveBeenCalledTimes(1);
    const gone = io({
      read: async () => ({ kind: 'ok', convo: convo(1, 0, { groupId: null }) }),
    });
    await r.tick(gone);
    expect(gone.show).not.toHaveBeenCalled();
    const next = io();
    await r.tick(next);
    expect(next.probe).not.toHaveBeenCalled();
  });
});
