// Who the floating meeting window shows large, what each camera is
// pulled at meanwhile, and who sits in its row of small avatars.

import type { ParticipantId, TileSize } from '@/lib/meetings/room/contract';
import { sizeForHeight } from '@/lib/meetings/room-ui/stage';

/** Above this many remote people, the unseen cameras are closed. */
export const FLOAT_WARM_CAMERAS = 8;

export type FloatView = 'speaker' | 'screen';

export interface FloatFocusInput {
  selfId: ParticipantId | null;
  /** Present participants in join order; our own row may be among them. */
  participantIds: readonly ParticipantId[];
  activeSpeakerId: ParticipantId | null;
  lastRemoteSpeakerId: ParticipantId | null;
  view: FloatView;
  /** Remote participants whose screen track has actually arrived. */
  receivedScreens: ReadonlySet<ParticipantId>;
}

export interface FloatFocus {
  /** Whose picture is large; ourselves only when alone. */
  mainId: ParticipantId | null;
  kind: 'camera' | 'screen';
  alone: boolean;
  /** The person a camera view would show, named under a screen. */
  speakerId: ParticipantId | null;
  /** A remote screen on offer: shows the Speaker/Screen switch. */
  screenId: ParticipantId | null;
}

export function floatFocus(input: FloatFocusInput): FloatFocus {
  const { selfId } = input;
  const remote = input.participantIds.filter((id) => id !== selfId);
  const pick = (id: ParticipantId | null) =>
    id && remote.includes(id) ? id : null;
  const speakerId =
    pick(input.activeSpeakerId) ??
    pick(input.lastRemoteSpeakerId) ?? // our voice or a pause moves nothing
    remote[0] ??
    null;
  const screenId = remote.find((id) => input.receivedScreens.has(id)) ?? null;
  const alone = remote.length === 0;
  return screenId && input.view === 'screen'
    ? { mainId: screenId, kind: 'screen', alone, speakerId, screenId }
    : {
        mainId: speakerId ?? selfId,
        kind: 'camera',
        alone,
        speakerId,
        screenId,
      };
}

export interface FloatSizesInput {
  participantIds: readonly ParticipantId[];
  selfId: ParticipantId | null;
  /** The camera drawn large; null when a screen is. */
  mainCameraId: ParticipantId | null;
  stageHeight: number;
  dpr: number;
  minimized: boolean;
}

/** Each remote camera's layer. Audio is separate and never affected. */
export function floatTileSizes(
  input: FloatSizesInput
): Record<ParticipantId, TileSize> {
  const remote = input.participantIds.filter((id) => id !== input.selfId);
  const main = sizeForHeight(input.stageHeight, input.dpr);
  const others: TileSize =
    remote.length <= FLOAT_WARM_CAMERAS ? 'small' : 'hidden';
  const sizes: Record<ParticipantId, TileSize> = {};
  for (const id of remote) {
    if (input.minimized) sizes[id] = 'hidden';
    else if (id !== input.mainCameraId) sizes[id] = others;
    else sizes[id] = main === 'small' ? 'medium' : main;
  }
  return sizes;
}

export interface FloatPerson {
  id: ParticipantId;
  speaking: boolean;
  handRaised: boolean;
}

/** The small avatars: speaking, then hands, then join order. */
export function otherPeople<T extends FloatPerson>(
  people: readonly T[],
  skip: readonly (ParticipantId | null)[],
  cap = 5
): { shown: T[]; extra: number } {
  const rank = (p: T) => (p.speaking ? 0 : p.handRaised ? 1 : 2);
  const rest = people
    .filter((p) => !skip.includes(p.id))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
  return { shown: rest.slice(0, cap), extra: Math.max(0, rest.length - cap) };
}

/** Who to name as speaking now; null for nobody, or only ourselves. */
export function speakerLine(
  activeSpeakerId: ParticipantId | null,
  speaking: Readonly<Record<ParticipantId, boolean>>,
  selfId: ParticipantId | null,
  nameOf: (id: ParticipantId) => string
): string | null {
  if (!activeSpeakerId || activeSpeakerId === selfId) return null;
  return speaking[activeSpeakerId] ? nameOf(activeSpeakerId) : null;
}
