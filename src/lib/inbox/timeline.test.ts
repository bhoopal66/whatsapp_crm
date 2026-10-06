import { describe, expect, it } from 'vitest';

import type { ConversationEvent, Message } from '@/types';

import {
  buildTimelineGroups,
  startsMessageRun,
  type TimelineItem,
} from './timeline';

const msg = (id: string, at: string) =>
  ({ id, created_at: at }) as unknown as Message;
const note = (id: string, at: string) =>
  ({ id, created_at: at, kind: 'channel_switched' }) as ConversationEvent;

const flat = (groups: ReturnType<typeof buildTimelineGroups>) =>
  groups.flatMap((g) =>
    g.items.map((i) =>
      i.kind === 'message' ? i.message.id : `note:${i.event.id}`
    )
  );

describe('buildTimelineGroups', () => {
  it('places a switch note between the messages either side of it', () => {
    const groups = buildTimelineGroups(
      [msg('m1', '2026-09-25T10:00:00Z'), msg('m2', '2026-09-25T10:05:00Z')],
      [note('e1', '2026-09-25T10:02:00Z')],
      false
    );
    expect(flat(groups)).toEqual(['m1', 'note:e1', 'm2']);
  });

  it('puts a note after a message with the same timestamp', () => {
    const groups = buildTimelineGroups(
      [msg('m1', '2026-09-25T10:00:00Z')],
      [note('e1', '2026-09-25T10:00:00Z')],
      false
    );
    expect(flat(groups)).toEqual(['m1', 'note:e1']);
  });

  it('shows a note on a thread with no messages yet', () => {
    expect(
      flat(buildTimelineGroups([], [note('e1', '2026-09-25T10:00:00Z')], false))
    ).toEqual(['note:e1']);
  });

  it('holds back notes older than the loaded page while older messages are unloaded', () => {
    const groups = buildTimelineGroups(
      [msg('m5', '2026-09-25T10:00:00Z')],
      [
        note('old', '2026-09-20T10:00:00Z'),
        note('new', '2026-09-25T11:00:00Z'),
      ],
      true
    );
    expect(flat(groups)).toEqual(['m5', 'note:new']);
  });

  it('orders notes that arrive out of order', () => {
    const groups = buildTimelineGroups(
      [],
      [note('b', '2026-09-25T11:00:00Z'), note('a', '2026-09-25T10:00:00Z')],
      false
    );
    expect(flat(groups)).toEqual(['note:a', 'note:b']);
  });

  it('starts a new day group at a date change', () => {
    const groups = buildTimelineGroups(
      [msg('m1', '2026-09-24T10:00:00Z'), msg('m2', '2026-09-26T10:00:00Z')],
      [],
      false
    );
    expect(groups).toHaveLength(2);
  });
});

describe('startsMessageRun', () => {
  const from = (
    id: string,
    sender_type: Message['sender_type']
  ): TimelineItem => ({
    kind: 'message',
    message: { id, sender_type } as Message,
  });
  const noteItem: TimelineItem = {
    kind: 'event',
    event: note('e1', '2026-09-25T10:00:00Z'),
  };

  it('opens a run at the first message and wherever the side changes', () => {
    const items = [
      from('c1', 'customer'),
      from('c2', 'customer'),
      from('a1', 'agent'),
      from('b1', 'bot'),
      from('c3', 'customer'),
    ];
    expect(items.map((_, i) => startsMessageRun(items, i))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('treats a note as a break, and is false for the note itself', () => {
    const items = [from('a1', 'agent'), noteItem, from('a2', 'agent')];
    expect(items.map((_, i) => startsMessageRun(items, i))).toEqual([
      true,
      false,
      true,
    ]);
  });
});
