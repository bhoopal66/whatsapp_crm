import { describe, expect, it } from 'vitest';

import { REACTION_TTL_MS } from '@/lib/meetings/room/chat';

import {
  canFullscreen,
  canPictureInPicture,
  DEFAULT_DEVICE,
  deviceChoices,
  deviceIdFor,
  deviceValue,
  REACTION_FLOAT_MS,
  reactionMotion,
  unreadBadge,
} from './controls';

describe('unreadBadge', () => {
  it('shows nothing at zero and caps at 99+', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-1)).toBeNull();
    expect(unreadBadge(Number.NaN)).toBeNull();
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(100)).toBe('99+');
  });
});

describe('device picker', () => {
  const options = [
    { deviceId: 'a', label: 'USB Mic' },
    { deviceId: 'b', label: '  ' },
  ];
  it('lists the default first, unnamed devices by ordinal', () => {
    expect(deviceChoices(options)).toEqual([
      { value: DEFAULT_DEVICE, label: null, ordinal: 0 },
      { value: 'a', label: 'USB Mic', ordinal: 1 },
      { value: 'b', label: null, ordinal: 2 },
    ]);
  });
  it('checks the default when the choice is gone or unset', () => {
    expect(deviceValue('a', options)).toBe('a');
    expect(deviceValue('gone', options)).toBe(DEFAULT_DEVICE);
    expect(deviceValue(null, options)).toBe(DEFAULT_DEVICE);
  });
  it('maps the default back to an empty id (the engine stores null)', () => {
    expect(deviceIdFor(DEFAULT_DEVICE)).toBe('');
    expect(deviceIdFor('a')).toBe('a');
  });
});

describe('reactionMotion', () => {
  it('ends invisible, before the engine drops the reaction', () => {
    for (const reduced of [false, true]) {
      const m = reactionMotion('r1', reduced);
      expect(m.options.duration).toBe(REACTION_FLOAT_MS);
      expect(m.keyframes.at(-1)?.opacity).toBe(0);
      expect(m.options.fill).toBe('forwards');
    }
    expect(REACTION_FLOAT_MS).toBeLessThan(REACTION_TTL_MS);
  });
  it('only fades with reduced motion', () => {
    const m = reactionMotion('r1', true);
    expect(m.keyframes.every((k) => k.transform === undefined)).toBe(true);
  });
  it('rises and sways by id', () => {
    const last = (id: string) =>
      String(reactionMotion(id, false).keyframes.at(-1)?.transform);
    expect(last('r1')).toMatch(/-48vh/);
    const sways = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => last(id).split(',')[0])
    );
    expect(sways.size).toBe(2);
  });
});

describe('support checks', () => {
  it('offers fullscreen only with the element API enabled', () => {
    const req = () => {};
    expect(
      canFullscreen({
        fullscreenEnabled: true,
        documentElement: { requestFullscreen: req },
      })
    ).toBe(true);
    expect(
      canFullscreen({
        fullscreenEnabled: false,
        documentElement: { requestFullscreen: req },
      })
    ).toBe(false);
    expect(
      canFullscreen({ fullscreenEnabled: true, documentElement: {} })
    ).toBe(false);
    expect(canFullscreen(undefined)).toBe(false);
  });
  it('offers picture-in-picture only when the document says so', () => {
    expect(canPictureInPicture({ pictureInPictureEnabled: true })).toBe(true);
    expect(canPictureInPicture({})).toBe(false);
    expect(canPictureInPicture(undefined)).toBe(false);
  });
});
