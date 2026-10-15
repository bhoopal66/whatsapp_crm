// Pure rules for the room's side panels (chat, people), the settings
// dialog and the notice toasts.

import type {
  MeetingChatMessage,
  ParticipantId,
  RoomNotice,
} from '@/lib/meetings/room/contract';

import { clampPanelWidth } from './keys';
import { handRaisedAtOf, orderPeople } from './people';

export type RoomPanelKind = 'chat' | 'people';

/** Phones get the panel as a bottom sheet instead of a column. */
export const PHONE_MEDIA_QUERY = '(max-width: 640px)';

export const PANEL_DEFAULT_WIDTH = 360;
/** Arrow keys on the resize handle move the edge this far. */
export const PANEL_KEY_STEP = 16;

/** C / P toggle their panel (or switch to it); Esc closes whichever is open. */
export function nextPanel(
  current: RoomPanelKind | null,
  shortcut: RoomPanelKind | 'closePanel'
): RoomPanelKind | null {
  if (shortcut === 'closePanel') return null;
  return current === shortcut ? null : shortcut;
}

/**
 * The panel sits on the right, so dragging its left edge leftwards
 * (a smaller clientX) widens it.
 */
export function dragPanelWidth(
  startWidth: number,
  startX: number,
  x: number
): number {
  return clampPanelWidth(startWidth + (startX - x));
}

/** createdAt of the newest chat line (the list is ascending), or null. */
export function latestChatAt(
  messages: readonly MeetingChatMessage[]
): string | null {
  return messages.at(-1)?.createdAt ?? null;
}

/** The counter shows once the draft is this close to the limit. */
export const CHAT_COUNTER_FROM = 200;

export function chatCounter(
  length: number,
  max: number
): { show: boolean; over: boolean } {
  return { show: length >= max - CHAT_COUNTER_FROM, over: length > max };
}

export interface PeopleRow {
  id: ParticipantId;
  user_id: string;
  audio_muted: boolean;
  video_off: boolean;
}

export interface PanelPerson {
  id: string;
  userId: string;
  name: string;
  isSelf: boolean;
  /** Ordering key; for our own not-yet-echoed hand, SELF_HAND_PENDING. */
  handRaisedAt: string | null;
  micOn: boolean;
  cameraOn: boolean;
}

/**
 * Our own hand before the row carries its timestamp: sorts after every
 * ISO time, so it joins the raised hands at the back of the queue.
 */
export const SELF_HAND_PENDING = '￿';

/**
 * The People list: every present seat, ourselves always included (our
 * row can lag the join) with our local mic, camera and hand state, which
 * is newer than the row's. Ordered by `orderPeople`.
 */
export function peopleForPanel(input: {
  rows: readonly PeopleRow[];
  self: {
    participantId: string | null;
    userId: string | null;
    name: string;
    micOn: boolean;
    cameraOn: boolean;
    handRaised: boolean;
  };
  nameOf: (userId: string) => string | null;
  unknownName: string;
}): PanelPerson[] {
  const { rows, self } = input;
  const selfRow = self.participantId
    ? rows.find((r) => r.id === self.participantId)
    : undefined;
  const people: PanelPerson[] = rows
    .filter((r) => r !== selfRow)
    .map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: input.nameOf(r.user_id) || input.unknownName,
      isSelf: false,
      handRaisedAt: handRaisedAtOf(r),
      micOn: !r.audio_muted,
      cameraOn: !r.video_off,
    }));
  people.push({
    id: self.participantId ?? 'self',
    userId: self.userId ?? '',
    name: self.name || input.unknownName,
    isSelf: true,
    handRaisedAt: self.handRaised
      ? ((selfRow && handRaisedAtOf(selfRow)) ?? SELF_HAND_PENDING)
      : null,
    micOn: self.micOn,
    cameraOn: self.cameraOn,
  });
  return orderPeople(people);
}

export type NoticeToastKey =
  | 'joined'
  | 'left'
  | 'mutedByHost'
  | 'handLoweredByHost'
  | 'micLost'
  | 'cameraLost'
  | 'qualityPoor';

export interface NoticeToast {
  key: NoticeToastKey;
  tone: 'info' | 'warning';
  /** Whose name the message carries (join / leave). */
  userId: string | null;
  /** The optional soft sound; only join and leave have one. */
  sound: 'join' | 'leave' | null;
}

export function noticeToast(n: RoomNotice): NoticeToast {
  switch (n.kind) {
    case 'joined':
      return { key: 'joined', tone: 'info', userId: n.userId, sound: 'join' };
    case 'left':
      return { key: 'left', tone: 'info', userId: n.userId, sound: 'leave' };
    case 'muted_by_host':
      return { key: 'mutedByHost', tone: 'info', userId: null, sound: null };
    case 'hand_lowered_by_host':
      return {
        key: 'handLoweredByHost',
        tone: 'info',
        userId: null,
        sound: null,
      };
    case 'device_lost':
      return {
        key: n.device === 'audio' ? 'micLost' : 'cameraLost',
        tone: 'warning',
        userId: null,
        sound: null,
      };
    case 'quality_poor':
      return { key: 'qualityPoor', tone: 'warning', userId: null, sound: null };
  }
}

/** localStorage key of the join/leave sound switch; off unless '1'. */
export const JOIN_LEAVE_SOUNDS_KEY = 'meetings.joinLeaveSounds.v1';

export function parseSoundPref(raw: string | null): boolean {
  return raw === '1';
}
