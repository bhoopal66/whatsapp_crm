import { describe, expect, it } from 'vitest';

import { avatarColor } from './people';
import {
  avatarTint,
  handQueueRank,
  meetingLink,
  tileAvatarSize,
} from './tile-view';

describe('tileAvatarSize', () => {
  it('takes about a third of the smaller side', () => {
    expect(tileAvatarSize({ width: 640, height: 360 })).toBe(115);
    expect(tileAvatarSize({ width: 200, height: 300 })).toBe(64);
  });

  it('stays within 40 and 128 px', () => {
    expect(tileAvatarSize({ width: 128, height: 72 })).toBe(40);
    expect(tileAvatarSize({ width: 1920, height: 1080 })).toBe(128);
  });
});

describe('avatarTint', () => {
  it('uses the hue of the person’s avatar', () => {
    for (const id of ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff']) {
      const hue = avatarColor(id).replace(/^bg-|-600$/g, '');
      expect(avatarTint(id)).toBe(`bg-${hue}-500/15`);
    }
  });
});

describe('handQueueRank', () => {
  const rows = [
    { id: 'late', hand_raised_at: '2026-11-05T10:00:09Z' },
    { id: 'down', hand_raised_at: null },
    { id: 'early', hand_raised_at: '2026-11-05T10:00:01Z' },
  ];

  it('numbers raised hands from the earliest', () => {
    expect(handQueueRank(rows, 'early', null, false)).toBe(1);
    expect(handQueueRank(rows, 'late', null, false)).toBe(2);
  });

  it('gives a lowered hand no place', () => {
    expect(handQueueRank(rows, 'down', null, false)).toBeNull();
  });

  it('breaks a tie on the id, so every screen agrees', () => {
    const at = '2026-11-05T10:00:01Z';
    const tied = [
      { id: 'b', hand_raised_at: at },
      { id: 'a', hand_raised_at: at },
    ];
    expect(handQueueRank(tied, 'a', null, false)).toBe(1);
    expect(handQueueRank([...tied].reverse(), 'b', null, false)).toBe(2);
  });

  it('puts our hand last until our row says when it went up', () => {
    expect(handQueueRank(rows, 'down', 'down', true)).toBe(3);
    expect(handQueueRank(rows, 'me', 'me', true)).toBe(3);
  });

  it('keeps our place once our row has it', () => {
    expect(handQueueRank(rows, 'early', 'early', true)).toBe(1);
  });

  it('drops our hand as soon as we lower it, and moves the queue up', () => {
    expect(handQueueRank(rows, 'early', 'early', false)).toBeNull();
    expect(handQueueRank(rows, 'late', 'early', false)).toBe(1);
  });

  it('leaves the rows in their order', () => {
    const before = rows.map((r) => r.id);
    handQueueRank(rows, 'late', null, false);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('meetingLink', () => {
  it('is the meeting’s page on this origin', () => {
    expect(meetingLink('https://crm.example', 'm1')).toBe(
      'https://crm.example/meetings/m1'
    );
  });
});
