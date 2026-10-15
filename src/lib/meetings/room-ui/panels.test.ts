import { describe, expect, it } from 'vitest';

import type { RoomNotice } from '@/lib/meetings/room/contract';

import {
  chatCounter,
  dragPanelWidth,
  latestChatAt,
  nextPanel,
  noticeToast,
  parseSoundPref,
  peopleForPanel,
  SELF_HAND_PENDING,
} from './panels';

describe('nextPanel', () => {
  it('toggles, switches and closes', () => {
    expect(nextPanel(null, 'chat')).toBe('chat');
    expect(nextPanel('chat', 'chat')).toBeNull();
    expect(nextPanel('chat', 'people')).toBe('people');
    expect(nextPanel('people', 'closePanel')).toBeNull();
    expect(nextPanel(null, 'closePanel')).toBeNull();
  });
});

describe('dragPanelWidth', () => {
  it('widens when the left edge moves left, within the clamp', () => {
    expect(dragPanelWidth(360, 1000, 940)).toBe(420);
    expect(dragPanelWidth(360, 1000, 1040)).toBe(320);
    expect(dragPanelWidth(360, 1000, 0)).toBe(520);
    expect(dragPanelWidth(360, 1000, 2000)).toBe(280);
  });
});

describe('latestChatAt / chatCounter / parseSoundPref', () => {
  it('reads the newest line', () => {
    expect(latestChatAt([])).toBeNull();
    expect(
      latestChatAt([
        { id: 'a', userId: 'u', body: 'x', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'b', userId: 'u', body: 'y', createdAt: '2026-01-01T00:01:00Z' },
      ])
    ).toBe('2026-01-01T00:01:00Z');
  });
  it('shows the counter near the limit and flags overflow', () => {
    expect(chatCounter(10, 2000)).toEqual({ show: false, over: false });
    expect(chatCounter(1800, 2000)).toEqual({ show: true, over: false });
    expect(chatCounter(2000, 2000)).toEqual({ show: true, over: false });
    expect(chatCounter(2001, 2000)).toEqual({ show: true, over: true });
  });
  it('treats only "1" as on', () => {
    expect(parseSoundPref('1')).toBe(true);
    expect(parseSoundPref(null)).toBe(false);
    expect(parseSoundPref('true')).toBe(false);
  });
});

describe('peopleForPanel', () => {
  const row = (
    id: string,
    user: string,
    extra: Partial<{
      audio_muted: boolean;
      video_off: boolean;
      hand_raised_at: string | null;
    }> = {}
  ) => ({
    id,
    user_id: user,
    audio_muted: false,
    video_off: false,
    hand_raised_at: null,
    ...extra,
  });
  const names: Record<string, string> = { ua: 'Ann', ub: 'Bob', uc: 'Cy' };
  const base = {
    nameOf: (u: string) => names[u] ?? null,
    unknownName: 'Someone',
  };
  const self = {
    participantId: 'p-me',
    userId: 'u-me',
    name: 'Me',
    micOn: true,
    cameraOn: false,
    handRaised: false,
  };

  it('puts raised hands first by time, then self, then by name', () => {
    const out = peopleForPanel({
      ...base,
      rows: [
        row('p-c', 'uc'),
        row('p-b', 'ub', { hand_raised_at: '2026-01-01T00:02:00Z' }),
        row('p-me', 'u-me', { audio_muted: true }),
        row('p-a', 'ua', { hand_raised_at: '2026-01-01T00:01:00Z' }),
        row('p-x', 'ux', { audio_muted: true, video_off: true }),
      ],
      self,
    });
    expect(out.map((p) => p.id)).toEqual(['p-a', 'p-b', 'p-me', 'p-c', 'p-x']);
    const me = out.find((p) => p.isSelf)!;
    // Local state beats the row: we unmuted after the row was written.
    expect(me).toMatchObject({ micOn: true, cameraOn: false, name: 'Me' });
    expect(out.at(-1)).toMatchObject({
      name: 'Someone',
      micOn: false,
      cameraOn: false,
    });
  });

  it('includes us before our row arrives, our pending hand last in the queue', () => {
    const out = peopleForPanel({
      ...base,
      rows: [row('p-a', 'ua', { hand_raised_at: '2026-01-01T00:01:00Z' })],
      self: { ...self, participantId: null, handRaised: true },
    });
    expect(out.map((p) => [p.id, p.handRaisedAt])).toEqual([
      ['p-a', '2026-01-01T00:01:00Z'],
      ['self', SELF_HAND_PENDING],
    ]);
  });

  it("uses our row's hand time once it is there", () => {
    const out = peopleForPanel({
      ...base,
      rows: [
        row('p-me', 'u-me', { hand_raised_at: '2026-01-01T00:00:30Z' }),
        row('p-a', 'ua', { hand_raised_at: '2026-01-01T00:01:00Z' }),
      ],
      self: { ...self, handRaised: true },
    });
    expect(out.map((p) => p.id)).toEqual(['p-me', 'p-a']);
    expect(out.filter((p) => p.isSelf)).toHaveLength(1);
  });
});

describe('noticeToast', () => {
  it('maps every notice kind', () => {
    const cases: [RoomNotice, string, string, string | null][] = [
      [{ id: '1', kind: 'joined', userId: 'u' }, 'joined', 'info', 'join'],
      [{ id: '2', kind: 'left', userId: 'u' }, 'left', 'info', 'leave'],
      [{ id: '3', kind: 'muted_by_host' }, 'mutedByHost', 'info', null],
      [
        { id: '4', kind: 'hand_lowered_by_host' },
        'handLoweredByHost',
        'info',
        null,
      ],
      [
        { id: '5', kind: 'device_lost', device: 'audio' },
        'micLost',
        'warning',
        null,
      ],
      [
        { id: '6', kind: 'device_lost', device: 'video' },
        'cameraLost',
        'warning',
        null,
      ],
      [{ id: '7', kind: 'quality_poor' }, 'qualityPoor', 'warning', null],
    ];
    for (const [n, key, tone, sound] of cases)
      expect(noticeToast(n)).toMatchObject({ key, tone, sound });
    expect(noticeToast({ id: '1', kind: 'joined', userId: 'u' }).userId).toBe(
      'u'
    );
  });
});
