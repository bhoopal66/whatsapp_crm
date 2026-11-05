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

/** The People tab's count: every seat, ourselves even before our row lands. */
export function peopleCount(
  rows: readonly { id: ParticipantId }[],
  selfId: string | null
): number {
  return rows.filter((r) => r.id !== selfId).length + 1;
}

/** The search box shows once the panel lists this many people. */
export const PEOPLE_SEARCH_FROM = 8;

export interface SectionPerson extends PanelPerson {
  isOrganiser: boolean;
  /** Place in the room's queue of hands, 1-based; null with no hand up. */
  queuePosition: number | null;
}

export interface NamedPerson {
  userId: string;
  name: string;
}

export interface PeopleSections {
  hands: SectionPerson[];
  here: SectionPerson[];
  invited: NamedPerson[];
  removed: NamedPerson[];
  searchable: boolean;
}

function nameMatcher(query: string): (text: string) => boolean {
  const q = query.trim().toLocaleLowerCase();
  return (text) => text.toLocaleLowerCase().includes(q);
}

/** The detail GET's `invitee_user_ids`; absent or malformed → []. */
export function parseInviteeIds(body: unknown): string[] {
  const list =
    body && typeof body === 'object' && 'invitee_user_ids' in body
      ? (body as { invitee_user_ids: unknown }).invitee_user_ids
      : null;
  if (!Array.isArray(list)) return [];
  return list.filter((id): id is string => typeof id === 'string');
}

/**
 * The People panel's sections, from `peopleForPanel`'s ordered list.
 * A queue number is given before the search filters, so a hand keeps its
 * place in the room. Below PEOPLE_SEARCH_FROM there is no box to clear,
 * so a query left over from a fuller room is ignored.
 */
export function peopleSections(input: {
  people: readonly PanelPerson[];
  hostUserId: string | null;
  inviteeUserIds: readonly string[];
  removedUserIds: readonly string[];
  nameOf: (userId: string) => string | null;
  unknownName: string;
  query: string;
}): PeopleSections {
  const named = (userId: string): NamedPerson => ({
    userId,
    name: input.nameOf(userId) || input.unknownName,
  });
  const byName = (a: NamedPerson, b: NamedPerson) =>
    a.name.localeCompare(b.name);

  let position = 0;
  const seats: SectionPerson[] = input.people.map((p) => ({
    ...p,
    isOrganiser: p.userId === input.hostUserId,
    queuePosition: p.handRaisedAt ? ++position : null,
  }));
  const gone = new Set([
    ...input.people.map((p) => p.userId),
    ...input.removedUserIds,
  ]);
  const invited = [...new Set(input.inviteeUserIds)]
    .filter((id) => !gone.has(id))
    .map(named)
    .sort(byName);
  const removed = input.removedUserIds.map(named);

  const total = seats.length + invited.length + removed.length;
  const searchable = total >= PEOPLE_SEARCH_FROM;
  const matches = nameMatcher(searchable ? input.query : '');
  const shown = seats.filter((p) => matches(p.name));
  return {
    hands: shown.filter((p) => p.queuePosition !== null),
    here: shown.filter((p) => p.queuePosition === null),
    invited: invited.filter((p) => matches(p.name)),
    removed: removed.filter((p) => matches(p.name)),
    searchable,
  };
}

export interface InviteMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  deactivated_at?: string | null;
}

/**
 * Who the organiser can still invite: live members (bank guests never
 * reach `useWorkspaceMembers`) outside `taken`, by name or email.
 */
export function inviteCandidates<T extends InviteMember>(
  members: readonly T[],
  taken: readonly string[],
  query: string
): T[] {
  const skip = new Set(taken);
  const matches = nameMatcher(query);
  return members.filter(
    (m) =>
      !m.deactivated_at &&
      !skip.has(m.user_id) &&
      matches(`${m.full_name ?? ''} ${m.email ?? ''}`)
  );
}

export type NoticeToastKey =
  | 'joined'
  | 'left'
  | 'mutedByHost'
  | 'handLoweredByHost'
  | 'micLost'
  | 'cameraLost'
  | 'qualityPoor'
  | 'recordingStarted'
  | 'recordingStopped'
  | 'meetingLocked'
  | 'meetingUnlocked';

export interface NoticeToast {
  key: NoticeToastKey;
  tone: 'info' | 'warning';
  /** Whose name the message carries (join, leave, recording started). */
  userId: string | null;
  /**
   * join and leave are the optional soft sounds; record is a consent
   * notice, so neither that switch nor the page silences it.
   */
  sound: 'join' | 'leave' | 'record' | null;
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
    case 'recording_started':
      return {
        key: 'recordingStarted',
        tone: 'warning',
        userId: n.userId,
        sound: 'record',
      };
    case 'recording_stopped':
      return {
        key: 'recordingStopped',
        tone: 'info',
        userId: null,
        sound: 'record',
      };
    case 'meeting_locked':
      return { key: 'meetingLocked', tone: 'info', userId: null, sound: null };
    case 'meeting_unlocked':
      return {
        key: 'meetingUnlocked',
        tone: 'info',
        userId: null,
        sound: null,
      };
  }
}

/** Off the room page join and leave stay quiet; nothing else does. */
export function showsToast(nt: NoticeToast, quietPresence: boolean): boolean {
  return !(quietPresence && (nt.sound === 'join' || nt.sound === 'leave'));
}

/**
 * The one tone a batch of notices plays, so a crowd arriving at once is
 * not a chord. A recording tone wins, and plays with the switch off.
 */
export function batchTone(
  toasts: readonly NoticeToast[],
  soundsOn: boolean
): NoticeToast['sound'] {
  const sounds = toasts.flatMap((nt) => (nt.sound ? [nt.sound] : []));
  if (sounds.includes('record')) return 'record';
  return soundsOn ? (sounds.at(-1) ?? null) : null;
}

/** localStorage key of the join/leave sound switch; off unless '1'. */
export const JOIN_LEAVE_SOUNDS_KEY = 'meetings.joinLeaveSounds.v1';

export function parseSoundPref(raw: string | null): boolean {
  return raw === '1';
}
