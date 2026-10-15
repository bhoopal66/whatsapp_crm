import { describe, expect, it } from 'vitest';

import {
  addReaction,
  mergeChat,
  parseMeetingMessage,
  pruneReactions,
  REACTION_TTL_MS,
} from './chat';
import {
  deviceOptionsFrom,
  effectiveSelection,
  mediaConstraints,
  parseDevicePrefs,
} from './devices';
import { dismissNotices, pushNotices } from './notices';
import { liveSince } from './presence';
import {
  classifyQuality,
  INITIAL_POOR_TRACKER,
  POOR_NOTICE_AFTER_MS,
  POOR_NOTICE_EVERY_MS,
  stepPoorTracker,
  summarizeStats,
} from './quality';
import { planSubscriptions } from './subscriptions';
import type { ParticipantRow } from './types';

function prow(id: string, joined: string, kinds: ('audio' | 'video')[] = []) {
  return {
    id,
    meeting_id: 'm',
    user_id: `u-${id}`,
    cf_session_id: `s-${id}`,
    joined_at: joined,
    last_seen_at: joined,
    left_at: null,
    tracks: kinds.map((kind) => ({ trackName: `${id}:${kind}`, kind })),
    audio_muted: false,
    video_off: false,
    hand_raised_at: null,
    mute_requested_at: null,
    removed_at: null,
    removed_by: null,
  } satisfies ParticipantRow;
}

describe('quality', () => {
  it('classifies by the worst measure', () => {
    expect(classifyQuality({})).toBe('unknown');
    expect(classifyQuality({ rttMs: 80, loss: 0, jitterMs: 5 })).toBe('good');
    expect(classifyQuality({ rttMs: 200 })).toBe('fair');
    expect(classifyQuality({ rttMs: 80, loss: 0.05 })).toBe('fair');
    expect(classifyQuality({ jitterMs: 40 })).toBe('fair');
    expect(classifyQuality({ rttMs: 500 })).toBe('poor');
    expect(classifyQuality({ rttMs: 50, loss: 0.1 })).toBe('poor');
    expect(classifyQuality({ jitterMs: 150 })).toBe('poor');
  });

  it('summarizes stats: selected pair RTT, outbound loss, inbound per participant by mid', () => {
    const reports = [
      { type: 'candidate-pair', nominated: false, currentRoundTripTime: 9 },
      { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.12 },
      { type: 'remote-inbound-rtp', fractionLost: 0.01 },
      { type: 'remote-inbound-rtp', fractionLost: 0.03 },
      {
        type: 'inbound-rtp',
        mid: '1',
        packetsLost: 20,
        packetsReceived: 190,
        jitter: 0.01,
      },
      { type: 'inbound-rtp', mid: '9', packetsLost: 5, packetsReceived: 5 },
    ];
    const r = summarizeStats(
      reports,
      { '1': 'p1' },
      { '1': { lost: 10, received: 100 } }
    );
    expect(r.self.rttMs).toBeCloseTo(120);
    expect(r.self.loss).toBe(0.03);
    expect(r.remote.p1.jitterMs).toBeCloseTo(10);
    // 10 lost of 100 sent since the last sample.
    expect(r.remote.p1.loss).toBeCloseTo(0.1);
    expect(r.counters).toEqual({ '1': { lost: 20, received: 190 } });
    expect(Object.keys(r.remote)).toEqual(['p1']);
  });

  it('a first sample has no loss figure (no previous counters)', () => {
    const r = summarizeStats(
      [{ type: 'inbound-rtp', mid: '1', packetsLost: 50, packetsReceived: 50 }],
      { '1': 'p1' },
      {}
    );
    expect(r.remote.p1.loss).toBeUndefined();
  });

  it('raises quality_poor after 10 s of poor, then at most every 2 min', () => {
    let s = INITIAL_POOR_TRACKER;
    const step = (q: 'poor' | 'good', t: number) => {
      const r = stepPoorTracker(s, q, t);
      s = r.state;
      return r.notify;
    };
    expect(step('poor', 0)).toBe(false);
    expect(step('poor', POOR_NOTICE_AFTER_MS - 1)).toBe(false);
    expect(step('poor', POOR_NOTICE_AFTER_MS)).toBe(true);
    expect(step('poor', POOR_NOTICE_AFTER_MS + 2000)).toBe(false);
    expect(step('good', 30_000)).toBe(false);
    expect(step('poor', 40_000)).toBe(false);
    expect(step('poor', 60_000)).toBe(false); // still inside the 2 min
    const later = POOR_NOTICE_AFTER_MS + POOR_NOTICE_EVERY_MS;
    expect(step('poor', later)).toBe(true);
  });
});

describe('chat and reactions', () => {
  const raw = (id: string, at: string, kind = 'chat', body = 'hi') => ({
    id,
    meeting_id: 'm',
    account_id: 'a',
    user_id: 'u1',
    kind,
    body,
    created_at: at,
  });

  it('parses chat and reaction rows, refusing anything else', () => {
    expect(parseMeetingMessage(raw('1', 't'))).toEqual({
      kind: 'chat',
      message: { id: '1', userId: 'u1', body: 'hi', createdAt: 't' },
    });
    expect(parseMeetingMessage(raw('2', 't', 'reaction', '👍'))?.kind).toBe(
      'reaction'
    );
    expect(parseMeetingMessage(raw('3', 't', 'reaction', '💩'))).toBeNull();
    expect(parseMeetingMessage(raw('4', 't', 'other'))).toBeNull();
    expect(parseMeetingMessage({ id: 5 })).toBeNull();
    expect(parseMeetingMessage(null)).toBeNull();
  });

  it('merges realtime and API reads: ascending, deduped, unchanged when nothing new', () => {
    const m = (id: string, at: string) => ({
      id,
      userId: 'u',
      body: id,
      createdAt: at,
    });
    const a = m('a', '2026-10-15T10:00:00Z');
    const b = m('b', '2026-10-15T10:00:01Z');
    const c = m('c', '2026-10-15T10:00:02Z');
    const chat = mergeChat([c], [a, b, c, a]);
    expect(chat.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(mergeChat(chat, [b])).toBe(chat);
  });

  it('keeps reactions for the TTL, by arrival time, once each', () => {
    const e = {
      id: 'r1',
      userId: 'u',
      emoji: '👍' as const,
      createdAt: '2000-01-01T00:00:00Z',
    };
    const held = addReaction([], e, 1000);
    expect(addReaction(held, e, 1200)).toBe(held);
    expect(pruneReactions(held, 1000 + REACTION_TTL_MS - 1)).toBe(held);
    expect(pruneReactions(held, 1000 + REACTION_TTL_MS)).toEqual([]);
  });
});

describe('devices', () => {
  it('reads stored choices tolerantly', () => {
    const none = { audioinput: null, videoinput: null, audiooutput: null };
    expect(parseDevicePrefs(null)).toEqual(none);
    expect(parseDevicePrefs('{oops')).toEqual(none);
    expect(parseDevicePrefs('[1]')).toEqual(none);
    expect(
      parseDevicePrefs(
        JSON.stringify({ audioinput: 'mic1', videoinput: 7, audiooutput: '' })
      )
    ).toEqual({ ...none, audioinput: 'mic1' });
  });

  it('groups devices, without the default aliases or duplicates', () => {
    const opts = deviceOptionsFrom([
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Comms' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      { kind: 'videoinput', deviceId: 'cam1', label: '' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
      { kind: 'audioinput', deviceId: '', label: '' },
      { kind: 'other', deviceId: 'x', label: 'x' },
    ]);
    expect(opts).toEqual({
      audioinput: [{ deviceId: 'mic1', label: 'Mic' }],
      videoinput: [{ deviceId: 'cam1', label: '' }],
      audiooutput: [{ deviceId: 'spk', label: 'Speakers' }],
    });
  });

  it('an unplugged choice reads as the default; no listed ids keeps it', () => {
    const prefs = { audioinput: 'gone', videoinput: 'cam1', audiooutput: 'x' };
    expect(
      effectiveSelection(prefs, {
        audioinput: [{ deviceId: 'mic1', label: '' }],
        videoinput: [{ deviceId: 'cam1', label: '' }],
        audiooutput: [],
      })
    ).toEqual({ audioinput: null, videoinput: 'cam1', audiooutput: 'x' });
  });

  it('asks for clean audio and 720p30 video, exactly the chosen device', () => {
    expect(mediaConstraints('audio', null)).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(mediaConstraints('video', 'cam1').video).toMatchObject({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      deviceId: { exact: 'cam1' },
    });
  });
});

describe('room v2 helpers', () => {
  it('liveSince is the earliest join of those present', () => {
    expect(liveSince([])).toBeNull();
    expect(
      liveSince([
        prow('a', '2026-10-15T10:05:00Z'),
        prow('b', '2026-10-15T10:01:00Z'),
      ])
    ).toBe('2026-10-15T10:01:00Z');
  });

  it('a hidden tile pulls no camera, but still the voice', () => {
    const rows = [prow('me', 't'), prow('p1', 't', ['audio', 'video'])];
    const plan = planSubscriptions(
      rows,
      'me',
      new Set(['p1:video']),
      new Set(['p1'])
    );
    expect(plan.pull.map((r) => r.trackName)).toEqual(['p1:audio']);
    expect(plan.close).toEqual(['p1:video']);
  });

  it('notices get ids, are capped, and are dismissed by id', () => {
    let n = 0;
    const next = () => `n${++n}`;
    type N = { id: string; kind: string };
    let list: N[] = [];
    list = pushNotices<N>(list, [{ kind: 'quality_poor' }], next);
    expect(list).toEqual([{ id: 'n1', kind: 'quality_poor' }]);
    expect(pushNotices<N>(list, [], next)).toBe(list);
    for (let i = 0; i < 30; i++) {
      list = pushNotices<N>(list, [{ kind: 'x' }], next);
    }
    expect(list).toHaveLength(20);
    expect(list[19].id).toBe('n31');
    const after = dismissNotices(list, ['n31', 'nope']);
    expect(after).toHaveLength(19);
    expect(dismissNotices(after, ['nope'])).toBe(after);
  });
});
