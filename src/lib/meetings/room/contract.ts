// The meeting room v2 contract between the call engine
// (hooks/use-meeting-call.ts) and the room screen
// (components/meetings/room/*). The engine owns every value here; the
// screen only reads them and calls the actions. Change both together.

import type { BackgroundEffect } from '../effects/types';
import type { BulkModerationAction } from '../types';
import type { RecordingFlag, RecordingFlagResult } from './recording';

/** A participant's id is `meeting_participants.id`; 'self' is never used. */
export type ParticipantId = string;

/** Connection quality from getStats (RTT, loss, jitter), coarse on purpose. */
export type Quality = 'good' | 'fair' | 'poor' | 'unknown';

/**
 * How large the screen draws a participant's video. The engine maps it to
 * a simulcast layer (large → full, medium → half, small → quarter,
 * hidden → no video pulled) so a 9-person grid does not pull nine 720p
 * streams.
 */
export type TileSize = 'large' | 'medium' | 'small' | 'hidden';

/** The fixed reaction set; the API refuses anything else. */
export const MEETING_REACTIONS = ['👍', '👏', '😂', '❤️', '🎉', '😮'] as const;
export type MeetingReaction = (typeof MEETING_REACTIONS)[number];

/** A chat line (`meeting_messages`, kind 'chat'). */
export interface MeetingChatMessage {
  id: string;
  /** Auth user id of the author. */
  userId: string;
  body: string;
  createdAt: string;
}

/** A reaction shown floating over the grid for a few seconds. */
export interface MeetingReactionEvent {
  id: string;
  userId: string;
  emoji: MeetingReaction;
  createdAt: string;
}

export type MediaDeviceKind = 'audioinput' | 'videoinput' | 'audiooutput';

export interface DeviceOption {
  deviceId: string;
  /** Empty until the browser has granted the permission. */
  label: string;
}

/** One-shot notices the screen turns into toasts, oldest first. */
export type RoomNotice =
  | { id: string; kind: 'joined'; userId: string }
  | { id: string; kind: 'left'; userId: string }
  | { id: string; kind: 'muted_by_host' }
  | { id: string; kind: 'hand_lowered_by_host' }
  | { id: string; kind: 'device_lost'; device: 'audio' | 'video' }
  | { id: string; kind: 'quality_poor' }
  /** The background effect stopped, so the camera was turned off. */
  | { id: string; kind: 'background_failed' }
  | { id: string; kind: 'recording_started'; userId: string }
  | { id: string; kind: 'recording_stopped' }
  | { id: string; kind: 'meeting_locked' }
  | { id: string; kind: 'meeting_unlocked' };

export type ModerationAction = 'mute' | 'remove' | 'lower_hand';

/** What v2 adds to the engine's snapshot. */
export interface CallSnapshotV2 {
  /** Loudest speaker in the last ~1 s, with hysteresis; may be our own id. */
  activeSpeakerId: ParticipantId | null;
  /** Who is speaking right now (audio level above the floor). */
  speaking: Record<ParticipantId, boolean>;
  /** 0..1, our microphone, updated at most ~5×/s (lobby meter, self ring). */
  localAudioLevel: number;
  /** Our own link and each remote participant's inbound link. */
  quality: { self: Quality; remote: Record<ParticipantId, Quality> };
  /** Available devices, refreshed on `devicechange`. */
  deviceOptions: Record<MediaDeviceKind, DeviceOption[]>;
  /** The chosen device per kind; null = the browser default. */
  selectedDevices: Record<MediaDeviceKind, string | null>;
  /** Whether the browser can route audio to a chosen output (setSinkId). */
  canSelectOutput: boolean;
  handRaised: boolean;
  /** Chat lines of this meeting, ascending by createdAt. */
  chat: MeetingChatMessage[];
  /** Reactions from the last few seconds. */
  reactions: MeetingReactionEvent[];
  notices: RoomNotice[];
  /** Earliest `joined_at` among present participants; drives the timer. */
  liveSince: string | null;
  /** Whether the viewer may moderate (host or owner/admin). */
  canModerate: boolean;
  /** The host has locked the meeting (176). */
  locked: boolean;
  /**
   * Who is recording. Not the bare flag: a recorder gone from the room
   * for the whole grace is hidden (`stepRecordingView`).
   */
  recording: RecordingFlag | null;
  /** The chosen background, kept even while the camera is off. */
  background: BackgroundEffect;
  /** The chosen background is still loading. */
  backgroundBusy: boolean;
  backgroundsSupported: boolean;
}

/** What v2 adds to the engine's actions. */
export interface CallActionsV2 {
  selectDevice: (kind: MediaDeviceKind, deviceId: string) => Promise<void>;
  /** Saved on this browser only; with the camera off, only remembered. */
  setBackground: (effect: BackgroundEffect) => Promise<void>;
  toggleHand: () => Promise<void>;
  sendChat: (body: string) => Promise<boolean>;
  sendReaction: (emoji: MeetingReaction) => Promise<void>;
  moderate: (
    target: ParticipantId,
    action: ModerationAction
  ) => Promise<boolean>;
  moderateAll: (action: BulkModerationAction) => Promise<boolean>;
  setLocked: (locked: boolean) => Promise<boolean>;
  /** The user ids invited, or null when the server refused. */
  invite: (userIds: string[]) => Promise<string[] | null>;
  /** `unavailable`: the database does not have migration 176 yet. */
  setRecordingFlag: (on: boolean) => Promise<RecordingFlagResult>;
  /** The screen reports how big each participant is drawn. */
  setTileSizes: (sizes: Record<ParticipantId, TileSize>) => void;
  /** Drop notices the screen has shown. */
  dismissNotices: (ids: string[]) => void;
}

export const V2_SNAPSHOT_DEFAULTS: CallSnapshotV2 = {
  activeSpeakerId: null,
  speaking: {},
  localAudioLevel: 0,
  quality: { self: 'unknown', remote: {} },
  deviceOptions: { audioinput: [], videoinput: [], audiooutput: [] },
  selectedDevices: { audioinput: null, videoinput: null, audiooutput: null },
  canSelectOutput: false,
  handRaised: false,
  chat: [],
  reactions: [],
  notices: [],
  liveSince: null,
  canModerate: false,
  locked: false,
  recording: null,
  background: { kind: 'none' },
  backgroundBusy: false,
  backgroundsSupported: false,
};
