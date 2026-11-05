import { describe, expect, it, vi } from 'vitest';

import { REACTION_TTL_MS } from '@/lib/meetings/room/chat';

import {
  canFullscreen,
  canPictureInPicture,
  DEFAULT_DEVICE,
  deviceChoices,
  deviceIdFor,
  deviceValue,
  handsRaised,
  REACTION_FLOAT_MS,
  reactionMotion,
  releasePointerFocus,
  returnFocusOnClose,
  unreadBadge,
} from './controls';

describe('handsRaised', () => {
  const up = '2026-11-05T10:00:00Z';

  it('counts the others from their rows', () => {
    const rows = [
      { id: 'me', hand_raised_at: null },
      { id: 'a', hand_raised_at: up },
      { id: 'b', hand_raised_at: null },
      { id: 'c', hand_raised_at: up },
    ];
    expect(handsRaised(rows, 'me', false)).toBe(2);
  });

  it('counts ours from the local state, never twice', () => {
    expect(handsRaised([{ id: 'me', hand_raised_at: null }], 'me', true)).toBe(
      1
    );
    expect(handsRaised([{ id: 'me', hand_raised_at: up }], 'me', true)).toBe(1);
    expect(handsRaised([{ id: 'me', hand_raised_at: up }], 'me', false)).toBe(
      0
    );
  });
});

describe('focus after a click', () => {
  const button = () => {
    const blur = vi.fn();
    return {
      blur,
      target: { closest: () => ({ blur }) } as unknown as Element,
    };
  };

  it('drops focus after a pointer click', () => {
    const { blur, target } = button();
    releasePointerFocus({ detail: 1, target });
    expect(blur).toHaveBeenCalled();
  });

  it('keeps it after a keyboard click', () => {
    const { blur, target } = button();
    releasePointerFocus({ detail: 0, target });
    expect(blur).not.toHaveBeenCalled();
  });

  it('ignores a click on no button', () => {
    const target = { closest: () => null } as unknown as Element;
    expect(() => releasePointerFocus({ detail: 1, target })).not.toThrow();
    expect(() =>
      releasePointerFocus({ detail: 1, target: null })
    ).not.toThrow();
  });

  it('gives a closing menu focus back only for a keyboard close', () => {
    expect(returnFocusOnClose('keyboard')).toBe(true);
    expect(returnFocusOnClose('mouse')).toBe(false);
    expect(returnFocusOnClose('touch')).toBe(false);
  });
});

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
