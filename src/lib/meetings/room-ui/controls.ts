// The control bar's pure parts: the Chat badge, the device picker's
// choices, the floating reactions' motion, and the support checks that
// decide whether fullscreen and picture-in-picture are offered at all.

import type { DeviceOption } from '@/lib/meetings/room/contract';

import { reactionOffset } from './people';

/** At or below this width the bar collapses to its phone form. */
export const COMPACT_BAR_QUERY = '(max-width: 640px)';

/** The Chat button's badge: nothing at 0, capped at 99+. */
export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/**
 * The radio value of "the browser default". No real device id takes it:
 * deviceOptionsFrom() leaves Chrome's `default` alias out.
 */
export const DEFAULT_DEVICE = 'default';

export interface DeviceChoice {
  value: string;
  /** null: the default entry, or a device the browser has not named. */
  label: string | null;
  /** 1-based position, for "Microphone 2" when there is no label. */
  ordinal: number;
}

/** The default entry first, then every listed device. */
export function deviceChoices(
  options: readonly DeviceOption[]
): DeviceChoice[] {
  return [
    { value: DEFAULT_DEVICE, label: null, ordinal: 0 },
    ...options.map((o, i) => ({
      value: o.deviceId,
      label: o.label.trim() || null,
      ordinal: i + 1,
    })),
  ];
}

/** The checked entry: a choice no longer listed reads as the default. */
export function deviceValue(
  selected: string | null,
  options: readonly DeviceOption[]
): string {
  return selected && options.some((o) => o.deviceId === selected)
    ? selected
    : DEFAULT_DEVICE;
}

/** What selectDevice() takes: '' clears the choice back to the default. */
export function deviceIdFor(value: string): string {
  return value === DEFAULT_DEVICE ? '' : value;
}

/** How long a reaction floats: inside the engine's REACTION_TTL_MS hold. */
export const REACTION_FLOAT_MS = 4_000;

export interface ReactionMotion {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

/**
 * A floating reaction's path for el.animate(): it rises from the bottom
 * of the stage with a small sway (left or right by its id, so a burst
 * does not move in lockstep) and fades out. With reduced motion it only
 * fades in place.
 */
export function reactionMotion(id: string, reduced: boolean): ReactionMotion {
  const options: KeyframeAnimationOptions = {
    duration: REACTION_FLOAT_MS,
    easing: 'ease-out',
    fill: 'forwards',
  };
  if (reduced) {
    return {
      keyframes: [
        { opacity: 0 },
        { opacity: 1, offset: 0.1 },
        { opacity: 1, offset: 0.75 },
        { opacity: 0 },
      ],
      options,
    };
  }
  const sway = reactionOffset(id) % 2 ? 16 : -16;
  return {
    keyframes: [
      { transform: 'translate(0, 0) scale(0.6)', opacity: 0 },
      {
        transform: `translate(${sway}px, -12vh) scale(1)`,
        opacity: 1,
        offset: 0.15,
      },
      {
        transform: `translate(${-sway}px, -32vh) scale(1)`,
        opacity: 1,
        offset: 0.6,
      },
      { transform: `translate(${sway}px, -48vh) scale(1)`, opacity: 0 },
    ],
    options,
  };
}

export interface FullscreenDocLike {
  fullscreenEnabled?: boolean;
  documentElement?: { requestFullscreen?: unknown } | null;
}

/**
 * Whether the page can go fullscreen. iPhone Safari has no element
 * fullscreen at all (only a <video>'s own player), so the button hides.
 */
export function canFullscreen(doc: FullscreenDocLike | undefined): boolean {
  return (
    !!doc &&
    doc.fullscreenEnabled === true &&
    typeof doc.documentElement?.requestFullscreen === 'function'
  );
}

export interface PipDocLike {
  pictureInPictureEnabled?: boolean;
}

/** Firefox has its own PiP toggle but not the API, so the button hides. */
export function canPictureInPicture(doc: PipDocLike | undefined): boolean {
  return !!doc && doc.pictureInPictureEnabled === true;
}
