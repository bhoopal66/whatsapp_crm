'use client';

// The meeting room's call engine: one RTCPeerConnection (one Cloudflare
// Realtime session) that both publishes our tracks and receives every
// other participant's. The browser never talks to Cloudflare's API: each
// SDP exchange goes through /api/meetings/[id]/sfu/*, which holds the
// app secret. Media flows browser <-> SFU directly.
//
// Every exchange runs through one serial queue (lib/meetings/room/queue):
// two overlapping offer/answer rounds on one connection corrupt its
// signalling state. Who is in the room, and what they publish, comes
// from `meeting_participants` (an initial read plus a realtime
// subscription); `planSubscriptions` turns that into pulls and closes.
//
// Choices worth knowing:
// - Mute is `track.enabled = false`: the mic stays published and sends
//   silence, so unmuting is instant and nobody renegotiates.
// - Camera off STOPS the camera track (the camera light goes out) and
//   replaces the sender's track with null, but keeps the published SFU
//   track. Closing and re-publishing it instead would make every other
//   participant close and re-pull it, two renegotiations per person per
//   toggle, and a re-publish would need a fresh track name. Peers show
//   the avatar from the row's `video_off`, which we push at once on
//   every toggle (POST state, v2).
// - The screen share is episodic, so stopping it closes its SFU track
//   (the featured tile must go away for everyone) and the next share
//   publishes a new generation of the name (`trackNameFor`).
// - ICE `failed`, or `disconnected` for 15 s, rejoins from scratch: a new
//   participant row and session, the same local tracks. Up to 3 tries.
//   A pull that keeps failing rejoins too (recovery.ts), on a budget of
//   its own that reaching `connected` does not reset.
// - A publish that fails releases the track it was for (devices.ts), so
//   the mic or camera reads as off with a device error, and turning it
//   on again opens the device and publishes afresh.
//
// v2 (contract.ts): the camera is published as three simulcast layers
// and each pulled camera asks for the layer its tile needs
// (simulcast.ts); levels are sampled every 200 ms for the active
// speaker and the mic meter, but the snapshot changes only when what
// it shows changes (speaker.ts levelPatch), or the whole room
// re-renders five times a second; getStats every 2 s grades the links
// (quality.ts). Remote levels come from getStats too: the SFU negotiates
// no audio-level header, so RTP sources report nothing (speaker.ts).
// Chat, reactions, hands and moderation go through the
// API; what the host did to our seat arrives on our own row
// (notices.ts). Every decision is a pure function under
// lib/meetings/room, tested there; this file only wires them.
//
// Background effects fail closed. `video` stays the raw camera and
// `processed` is what the effect makes of it. With a background chosen,
// only `processed` may reach a sender (`sendable`): while it loads,
// nothing is sent, and if it gives up the camera goes off, because the
// processor passes raw frames until someone acts.

import { useMemo, useSyncExternalStore } from 'react';

import type { AccountRole } from '@/lib/auth/roles';
import {
  EFFECT_PREF_KEY,
  parseEffectPref,
  serializeEffectPref,
} from '@/lib/meetings/effects/prefs';
import {
  createVideoEffectProcessor,
  effectsSupported,
  type VideoEffectProcessor,
} from '@/lib/meetings/effects/processor';
import type { BackgroundEffect } from '@/lib/meetings/effects/types';
import {
  addReaction,
  mergeChat,
  parseMeetingMessage,
  pruneReactions,
  type HeldReaction,
} from '@/lib/meetings/room/chat';
import {
  dismissNotices,
  pushNotices,
  selfRowEffects,
  stepPresence,
  type NoticeDraft,
  type PresenceMemo,
  type SelfRowMemo,
} from '@/lib/meetings/room/notices';
import {
  classifyQuality,
  INITIAL_POOR_TRACKER,
  QUALITY_INTERVAL_MS,
  stepPoorTracker,
  summarizeStats,
  type LossCounters,
  type StatLike,
} from '@/lib/meetings/room/quality';
import {
  CAMERA_ENCODINGS,
  hiddenVideo,
  landedPull,
  planLayerUpdates,
  pullSimulcast,
  type Rid,
} from '@/lib/meetings/room/simulcast';
import {
  inboundAudioLevels,
  INITIAL_SPEAKER_STATE,
  levelPatch,
  remoteLevel,
  rmsLevel,
  sameRecord,
  stepSpeaker,
} from '@/lib/meetings/room/speaker';
import { canManageMeeting } from '@/lib/meetings/schedule';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  afterFailedPublish,
  classifyMediaError,
  DEVICE_PREFS_KEY,
  deviceOptionsFrom,
  effectiveSelection,
  isBusyDeviceError,
  isShareCancelled,
  keepOpenedTrack,
  mediaConstraints,
  parseDevicePrefs,
  tracksToRelease,
  type DevicePrefs,
} from '@/lib/meetings/room/devices';
import type { DeviceError } from '@/lib/meetings/room/devices';
import {
  clockSkewMs,
  HEARTBEAT_INTERVAL_MS,
  liveSince,
  presentParticipants,
} from '@/lib/meetings/room/presence';
import { createSerialQueue } from '@/lib/meetings/room/queue';
import { isOwnRemoval } from '@/lib/meetings/room/removed';
import {
  admitPullRejoin,
  afterPullStrike,
  needsPullRollback,
} from '@/lib/meetings/room/recovery';
import {
  classifyRoomFailure,
  parseJoinResult,
  parseTracksResult,
  type RoomError,
  type TracksResult,
} from '@/lib/meetings/room/sfu';
import {
  lateRecordingNotices,
  meetingFlagNotices,
  lockFailure,
  recordingFailure,
  recordingFlagOf,
  stepRecordingView,
  type RecordingFlag,
  type RecordingMemo,
} from '@/lib/meetings/room/recording';
import { planSubscriptions } from '@/lib/meetings/room/subscriptions';
import { parseParticipantRow, trackNameFor } from '@/lib/meetings/room/tracks';
import {
  PARTICIPANT_COLUMNS,
  type ParticipantRow,
  type RemoteTrackRef,
  type TrackKind,
} from '@/lib/meetings/room/types';
import {
  V2_SNAPSHOT_DEFAULTS,
  type CallActionsV2,
  type CallSnapshotV2,
  type MediaDeviceKind,
  type MeetingReaction,
  type ModerationAction,
  type ParticipantId,
  type Quality,
  type RoomNotice,
  type TileSize,
} from '@/lib/meetings/room/contract';
import type { BulkModerationAction } from '@/lib/meetings/types';
import { createClient } from '@/lib/supabase/client';

export type CallPhase =
  | 'lobby'
  | 'joining'
  | 'live'
  | 'reconnecting'
  | 'left'
  /** The host removed us (v2). */
  | 'removed'
  | 'ended'
  | 'error';

export interface MeetingSummary {
  id: string;
  title: string;
  status: string;
  host_user_id: string;
  description?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  open_to_workspace?: boolean;
  /** These three are absent on a database without migration 176. */
  locked_at?: string | null;
  recording_started_at?: string | null;
  recording_by?: string | null;
}

export interface CallSnapshot extends CallSnapshotV2 {
  phase: CallPhase;
  error: RoomError | null;
  /** `missing`: not found, or not visible to this person (RLS). */
  meetingState: 'loading' | 'ready' | 'missing';
  meeting: MeetingSummary | null;
  devices: Record<'audio' | 'video' | 'screen', DeviceError | null>;
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  localVideo: MediaStreamTrack | null;
  /** What a recording of us may show: never raw behind a chosen background. */
  recordableVideo: MediaStreamTrack | null;
  localScreen: MediaStreamTrack | null;
  participantId: string | null;
  /** Present participants, ourselves included once our row arrives. */
  participants: ParticipantRow[];
  /** Received tracks by participant id. */
  remote: Record<string, Partial<Record<TrackKind, MediaStreamTrack>>>;
}

const RECONNECT_TRIES = 3;
const DISCONNECTED_GRACE_MS = 15_000;
const REPLAN_TICK_MS = 5_000;
/** Speaker and mic-meter sampling: at most 5 snapshot changes a second. */
const LEVEL_TICK_MS = 200;
/** How often the lobby reads the meeting again; see `refreshLobby`. */
const LOBBY_REFRESH_MS = 5_000;
/** Tile sizes settle (a resize drags through many) before a layer switch. */
const LAYER_DEBOUNCE_MS = 300;
/** A shared screen is text: one layer, enough bits to stay legible. */
const SCREEN_MAX_BITRATE = 2_500_000;
const CHAT_MAX = 2000;
/** Joining or turning the camera on with a background still loading. */
const EFFECT_WAIT_MS = 8_000;
/** Picking one: a cold load is slow, and the sender is empty meanwhile. */
const EFFECT_PICK_WAIT_MS = 30_000;

interface Pulled {
  mid: string;
  participantId: string;
  sessionId: string;
  kind: TrackKind;
  track: MediaStreamTrack;
  receiver: RTCRtpReceiver;
  /** The simulcast layer last asked for (cameras only). */
  rid: Rid | null;
}

interface ApiAnswer {
  ok: boolean;
  status: number;
  body: unknown;
}

export class MeetingCallEngine {
  private listeners = new Set<() => void>();
  private snap: CallSnapshot;
  private queue = createSerialQueue();
  private pc: RTCPeerConnection | null = null;
  private participantId: string | null = null;
  private rows = new Map<string, ParticipantRow>();
  private pulled = new Map<string, Pulled>();
  private pending = new Set<string>();
  private audio: MediaStreamTrack | null = null;
  /** The raw camera, always; `outgoing()` is what others get. */
  private video: MediaStreamTrack | null = null;
  private effect: BackgroundEffect = { kind: 'none' };
  /** One per start; set exactly while a background runs on the camera. */
  private processor: VideoEffectProcessor | null = null;
  private processed: MediaStreamTrack | null = null;
  /** Set while the processor starts; settles early if it is stopped. */
  private effectLoading: Promise<void> | null = null;
  private settleEffect: (() => void) | null = null;
  /** Bumped by stopEffect: a late answer from an old start is ignored. */
  private effectRun = 0;
  private screen: MediaStreamTrack | null = null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  /** The published screen track, set once its publish has landed. */
  private screenPub: { transceiver: RTCRtpTransceiver; name: string } | null =
    null;
  private screenGeneration = 0;
  /** Device opens in flight, so a double click opens one camera. */
  private opening = new Set<'audio' | 'video' | 'screen'>();
  private channel: RealtimeChannel | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private skew = 0;
  private attempts = 0;
  /** Consecutive pulls that failed after touching signalling. */
  private pullStrikes = 0;
  /** When pull strikes last rejoined; survives the rejoin's teardown. */
  private pullRejoins: number[] = [];
  private attached = false;
  // Bumped on every attach/detach. React's dev double-mount runs
  // attach → detach → attach; a getUserMedia from the first attach that
  // resolves after the second must stop its track, not keep the camera on.
  private epoch = 0;
  // --- v2 state ---
  private viewer: { userId: string | null; role: AccountRole | null } = {
    userId: null,
    role: null,
  };
  private prefs: DevicePrefs = {
    audioinput: null,
    videoinput: null,
    audiooutput: null,
  };
  private tileSizes: Record<ParticipantId, TileSize> = {};
  private layerTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private speaker = INITIAL_SPEAKER_STATE;
  private audioCtx: AudioContext | null = null;
  private analyser: {
    track: MediaStreamTrack;
    source: MediaStreamAudioSourceNode;
    node: AnalyserNode;
    buf: Float32Array<ArrayBuffer>;
  } | null = null;
  private lossCounters: Record<string, LossCounters> = {};
  private poor = INITIAL_POOR_TRACKER;
  /** The latest getStats reading of each remote person's level. */
  private remoteLevels: Record<ParticipantId, number> = {};
  private remoteLevelsBusy = false;
  /**
   * Who was present at the last plan, and departures still in their
   * grace (notices.ts); null until the initial read lands.
   */
  private presenceMemo: PresenceMemo | null = null;
  private rowsLoaded = false;
  private selfMemo: { seat: string; memo: SelfRowMemo } | null = null;
  /** The hand we last asked for, so our own lowering is not the host's. */
  private handWanted = false;
  private reactionsHeld: HeldReaction[] = [];
  private noticeSeq = 0;
  /**
   * Kept across a rejoin: the grace of a recorder already gone runs on,
   * rather than restarting each time our own network drops.
   */
  private recordingMemo: RecordingMemo | null = null;
  /** The last recording we raised a notice for; kept across a rejoin. */
  private recordingAnnounced: RecordingFlag | null = null;
  /** Bumped per newer view of the row, so an older read cannot undo it. */
  private meetingWrites = 0;
  private onDeviceChange = () => void this.refreshDevices();
  // Bumped whenever the person stops wanting to be in the call (leave,
  // end, a give-up, unmount). A join whose POST was in flight then — a
  // reconnect's, typically, since Leave stays on screen while
  // reconnecting — must give its new seat back, not go live.
  private session = 0;

  // Lazily: the engine is also constructed during the server render.
  private get supabase(): SupabaseClient {
    return createClient();
  }

  constructor(readonly meetingId: string) {
    this.snap = {
      ...V2_SNAPSHOT_DEFAULTS,
      phase: 'lobby',
      error: null,
      meetingState: 'loading',
      meeting: null,
      devices: { audio: null, video: null, screen: null },
      micOn: false,
      cameraOn: false,
      sharing: false,
      localVideo: null,
      recordableVideo: null,
      localScreen: null,
      participantId: null,
      participants: [],
      remote: {},
    };
  }

  // --- store ---------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  /** The live mic: a mute is `enabled = false` on this same track. */
  get micTrack(): MediaStreamTrack | null {
    return this.audio;
  }

  /** A snapshot with the actions: the shape the screens work from. */
  toCall(snap: CallSnapshot): MeetingCall {
    return {
      ...snap,
      join: this.join,
      returnToLobby: this.returnToLobby,
      leave: this.leave,
      end: this.end,
      toggleMic: this.toggleMic,
      toggleCamera: this.toggleCamera,
      toggleScreen: this.toggleScreen,
      selectDevice: this.selectDevice,
      setBackground: this.setBackground,
      toggleHand: this.toggleHand,
      sendChat: this.sendChat,
      sendReaction: this.sendReaction,
      moderate: this.moderate,
      moderateAll: this.moderateAll,
      setLocked: this.setLocked,
      invite: this.invite,
      setRecordingFlag: this.setRecordingFlag,
      setTileSizes: this.setTileSizes,
      dismissNotices: this.dismissNotices,
    };
  }

  private emit(patch: Partial<CallSnapshot> = {}) {
    const remote: CallSnapshot['remote'] = {};
    for (const p of this.pulled.values()) {
      (remote[p.participantId] ??= {})[p.kind] = p.track;
    }
    this.snap = {
      ...this.snap,
      micOn: !!this.audio && this.audio.enabled,
      cameraOn: !!this.video,
      sharing: !!this.screen,
      localVideo: this.outgoing(),
      recordableVideo: this.sendable(),
      localScreen: this.screen,
      background: this.effect,
      backgroundBusy: !!this.effectLoading,
      participantId: this.participantId,
      remote,
      ...patch,
    };
    for (const fn of this.listeners) fn();
  }

  private setDevice(
    kind: keyof CallSnapshot['devices'],
    err: DeviceError | null
  ) {
    this.emit({ devices: { ...this.snap.devices, [kind]: err } });
  }

  // --- lifecycle -------------------------------------------------------

  attach() {
    this.attached = true;
    this.epoch += 1;
    this.prefs = readDevicePrefs();
    this.effect = readEffectPref();
    this.emit({
      selectedDevices: { ...this.prefs },
      canSelectOutput:
        typeof HTMLMediaElement !== 'undefined' &&
        'setSinkId' in HTMLMediaElement.prototype,
      backgroundsSupported: effectsSupported(),
    });
    navigator.mediaDevices?.addEventListener?.(
      'devicechange',
      this.onDeviceChange
    );
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_TICK_MS);
    this.lobbyTimer = setInterval(
      () => void this.refreshLobby(),
      LOBBY_REFRESH_MS
    );
    void this.loadMeeting();
    void this.startPreview();
  }

  /** Unmount: leave the call and release every device. */
  detach() {
    this.attached = false;
    this.epoch += 1;
    this.session += 1;
    this.leaveQuietly();
    this.teardown();
    this.stopMedia();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;
    navigator.mediaDevices?.removeEventListener?.(
      'devicechange',
      this.onDeviceChange
    );
    this.dropAnalyser();
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  /** The signed-in person and their role, from the auth context. */
  setViewer(userId: string | null, role: AccountRole | null) {
    this.viewer = { userId, role };
    this.updateCanModerate();
  }

  private updateCanModerate() {
    const m = this.snap.meeting;
    const canModerate =
      !!m &&
      canManageMeeting(this.viewer.role, this.viewer.userId, {
        hostUserId: m.host_user_id,
      });
    if (canModerate !== this.snap.canModerate) this.emit({ canModerate });
  }

  /** pagehide: the tab is going away; tell the server while we still can. */
  leaveQuietly() {
    if (this.participantId) this.leaveSeat(this.participantId);
  }

  private leaveSeat(participantId: string, reconnecting = false) {
    const body = reconnecting
      ? { participantId, reconnecting: true }
      : { participantId };
    void this.api('leave', 'POST', body, true);
  }

  // Every column, not a list: naming 176's would fail the read, and so
  // the room, on a database without it.
  private readMeeting() {
    return this.supabase
      .from('meetings')
      .select('*')
      .eq('id', this.meetingId)
      .maybeSingle();
  }

  private async loadMeeting() {
    const writes = this.meetingWrites;
    const { data, error } = await this.readMeeting();
    // An error reads as missing too: the room cannot be shown either way.
    if (data && !error) {
      if (writes === this.meetingWrites) {
        this.applyMeeting(data as MeetingSummary);
      }
      this.emit({ meetingState: 'ready' });
    } else {
      // Since 112 a removal hides the meeting: say so rather than "not found".
      const removed = !error && (await this.isRemoved(null));
      this.emit({ meetingState: 'missing' });
      // removed() also releases the lobby preview's camera and mic.
      if (removed) this.removed();
    }
    this.updateCanModerate();
  }

  /**
   * Our own removal row (110's policy lets a person read theirs; a
   * manager reads every row of the meeting). Without `userId` (the auth
   * context may not have loaded yet) it asks for any row: only right
   * when the meeting is hidden from us, so we cannot be its manager.
   */
  private async isRemoved(userId: string | null): Promise<boolean> {
    let q = this.supabase
      .from('meeting_removed_users')
      .select('user_id')
      .eq('meeting_id', this.meetingId);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.limit(1);
    return !error && (data?.length ?? 0) > 0;
  }

  // --- devices ---------------------------------------------------------

  /**
   * `releaseBusy`, when given, frees the device the open competes with
   * and says whether it did; a busy refusal is then retried once.
   */
  private async open(
    kind: 'audio' | 'video',
    releaseBusy?: () => boolean
  ): Promise<MediaStreamTrack | null> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      this.setDevice(kind, 'unsupported');
      return null;
    }
    const epoch = this.epoch;
    // Leave, removal or the end can come while the prompt is open; they
    // stop every device first, so what opens after must not be kept.
    const at = { session: this.session, epoch };
    const wanted = () =>
      this.attached &&
      keepOpenedTrack(at, {
        session: this.session,
        epoch: this.epoch,
        phase: this.snap.phase,
      });
    const chosen = this.prefs[kind === 'audio' ? 'audioinput' : 'videoinput'];
    const get = () =>
      navigator.mediaDevices
        .getUserMedia(mediaConstraints(kind, chosen))
        .catch((err) => {
          // The chosen device is gone (unplugged since): the default.
          if (!chosen || classifyMediaError(err) !== 'not_found') throw err;
          return navigator.mediaDevices.getUserMedia(
            mediaConstraints(kind, null)
          );
        });
    try {
      const stream = await get().catch((err) => {
        // Many phones and some USB cameras open one camera at a time.
        if (!releaseBusy || !isBusyDeviceError(err) || !wanted()) throw err;
        if (!releaseBusy()) throw err;
        return get();
      });
      const track = stream.getTracks()[0] ?? null;
      if (!wanted()) {
        track?.stop();
        return null;
      }
      this.setDevice(kind, null);
      // Unplugged, or revoked by the OS. stop() never fires 'ended'.
      track?.addEventListener('ended', () => this.onTrackEnded(kind, track));
      return track;
    } catch (err) {
      if (epoch === this.epoch) this.setDevice(kind, classifyMediaError(err));
      return null;
    }
  }

  private async startPreview() {
    const epoch = this.epoch;
    // Separately, so a missing camera never costs the microphone.
    const [audio, video] = await Promise.all([
      this.audio ? this.audio : this.open('audio'),
      this.video ? this.video : this.open('video'),
    ]);
    if (epoch !== this.epoch) {
      // The page was left mid-open. open() stops only what resolves late;
      // one that resolved first is ours to stop, or the mic stays live.
      for (const t of tracksToRelease([audio, video], [this.audio, this.video]))
        t.stop();
      return;
    }
    this.audio = audio;
    this.video = video;
    this.emit();
    // Started here, so the lobby shows it and a join rarely has to wait.
    void this.ensureEffect();
    // Labels and ids are only listed once a permission is granted.
    void this.refreshDevices();
  }

  /** After leaving: back to the lobby, devices reopened. */
  returnToLobby = async () => {
    if (this.isLive() || this.snap.phase === 'joining') return;
    this.attempts = 0;
    this.pullRejoins = [];
    this.emit({ phase: 'lobby', error: null });
    await this.startPreview();
  };

  private stopMedia() {
    this.stopEffect();
    for (const t of [this.audio, this.video, this.screen]) t?.stop();
    this.audio = this.video = this.screen = null;
  }

  // --- background effects ----------------------------------------------

  /** What our self-view shows: raw only until a chosen background loads. */
  private outgoing() {
    return this.processed ?? this.video;
  }

  /** What a sender may carry. Null while a chosen background is not ready. */
  private sendable() {
    return this.effect.kind === 'none' ? this.video : this.processed;
  }

  private stopEffect() {
    this.effectRun += 1;
    this.processor?.stop();
    this.processor = null;
    this.processed = null;
    this.effectLoading = null;
    this.settleEffect?.();
    this.settleEffect = null;
  }

  /** Brings the chosen background up on the raw camera, if it is not yet. */
  private ensureEffect(): Promise<void> {
    const raw = this.video;
    if (!raw || this.effect.kind === 'none' || this.processed)
      return Promise.resolve();
    if (this.effectLoading) return this.effectLoading;
    const run = ++this.effectRun;
    const processor = createVideoEffectProcessor();
    this.processor = processor;
    processor.onGiveUp(() => {
      if (run === this.effectRun) this.effectFailed();
    });
    this.effectLoading = new Promise<void>((settle) => {
      this.settleEffect = settle;
      processor.start(raw, this.effect).then(
        (out) => {
          if (run !== this.effectRun) return; // stopEffect stopped it
          this.processed = out;
          this.effectLoading = null;
          this.settleEffect = null;
          this.emit();
          settle();
        },
        () => {
          if (run === this.effectRun) this.effectFailed();
        }
      );
    });
    this.emit();
    return this.effectLoading;
  }

  /** `ensureEffect`, or the camera off once `ms` have passed. */
  private async awaitEffect(ms: number) {
    const loading = this.ensureEffect();
    const processor = this.processor;
    if (!this.effectLoading) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      loading.then(() => false),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(true), ms);
      }),
    ]);
    clearTimeout(timer);
    if (expired && processor === this.processor) this.effectFailed();
  }

  /**
   * Fail closed, in the tick it happened: the processor passes raw frames
   * from here on. The choice stays, so the camera's next turn tries again.
   */
  private effectFailed() {
    void this.videoSender?.replaceTrack(null).catch(() => {});
    this.stopEffect();
    this.video?.stop();
    this.video = null;
    this.emit({ notices: this.withNotices([{ kind: 'background_failed' }]) });
    void this.pushState();
  }

  setBackground = async (next: BackgroundEffect) => {
    this.effect = next;
    try {
      const saved = serializeEffectPref(next);
      if (saved) localStorage.setItem(EFFECT_PREF_KEY, saved);
    } catch {
      // Private mode or full storage: the choice lasts this visit only.
    }
    const raw = this.video;
    if (!raw) return this.emit(); // off: applies when it is next turned on
    if (next.kind === 'none') {
      this.stopEffect();
      this.emit();
      await this.videoSender?.replaceTrack(raw).catch(() => {});
      return;
    }
    // Once a background is chosen the raw camera is never sent: the sender
    // goes empty now, not when the effect is ready. Tiles hold their last
    // frame meanwhile, so this is no `video_off`. A running effect is
    // already what the sender carries.
    const cleared = this.processed
      ? undefined
      : this.videoSender?.replaceTrack(null).catch(() => {});
    this.processor?.setEffect(next);
    this.emit();
    const ready = this.awaitEffect(EFFECT_PICK_WAIT_MS);
    await cleared;
    await ready;
    const out = this.processed;
    if (out) await this.videoSender?.replaceTrack(out).catch(() => {});
  };

  toggleMic = async () => {
    if (this.opening.has('audio')) return;
    if (!this.audio) {
      this.opening.add('audio');
      this.audio = await this.open('audio').finally(() =>
        this.opening.delete('audio')
      );
      // No track means no live publication either: a failed publish
      // released it (devices.ts), so this is also the retry.
      if (this.audio && this.isLive()) {
        if (this.audioSender) await this.audioSender.replaceTrack(this.audio);
        else await this.publish([{ track: this.audio, kind: 'audio' }]);
      }
    } else {
      this.audio.enabled = !this.audio.enabled;
    }
    void this.audioCtx?.resume().catch(() => {});
    this.emit();
    void this.pushState();
  };

  toggleCamera = async () => {
    if (this.opening.has('video')) return;
    if (this.video) {
      this.stopEffect();
      this.video.stop();
      this.video = null;
      this.emit();
      await this.videoSender?.replaceTrack(null).catch(() => {});
    } else {
      this.opening.add('video');
      const track = await this.open('video').finally(() =>
        this.opening.delete('video')
      );
      if (!track) return;
      this.video = track;
      this.emit();
      await this.awaitEffect(EFFECT_WAIT_MS);
      // Null if the background failed: effectFailed said why.
      const out = this.sendable();
      if (!out) return;
      if (this.isLive()) {
        if (this.videoSender) await this.videoSender.replaceTrack(out);
        else await this.publish([{ track: out, kind: 'video' }]);
      }
    }
    void this.pushState();
  };

  toggleScreen = async () => {
    if (this.screen) return this.stopShare();
    if (this.opening.has('screen')) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.setDevice('screen', 'unsupported');
      return;
    }
    let track: MediaStreamTrack | null = null;
    const at = { session: this.session, epoch: this.epoch };
    this.opening.add('screen');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      track = stream.getVideoTracks()[0] ?? null;
    } catch (err) {
      this.setDevice(
        'screen',
        isShareCancelled(err) ? null : classifyMediaError(err)
      );
      return;
    } finally {
      this.opening.delete('screen');
    }
    if (!track) return;
    if (
      !this.attached ||
      !keepOpenedTrack(at, {
        session: this.session,
        epoch: this.epoch,
        phase: this.snap.phase,
      })
    ) {
      track.stop();
      return;
    }
    this.setDevice('screen', null);
    // Text stays sharp; motion may drop frames instead.
    track.contentHint = 'detail';
    this.screen = track;
    // The browser's own "Stop sharing" bar ends the track.
    track.addEventListener('ended', () => {
      if (this.screen === track) void this.stopShare();
    });
    this.emit();
    if (this.isLive()) await this.publish([{ track, kind: 'screen' }]);
  };

  private async stopShare() {
    this.screen?.stop();
    this.screen = null;
    this.emit();
    if (!this.isLive()) return;
    // Queued, so a share whose publish is still in flight is closed once
    // it lands rather than left published with a stopped track.
    await this.queue
      .run(async () => {
        const pub = this.screenPub;
        if (!pub || this.screen) return;
        this.screenPub = null;
        await this.negotiateClose([pub.transceiver], [pub.name]);
      })
      .catch(() => {});
  }

  // --- joining ---------------------------------------------------------

  private isLive() {
    return !!this.pc && !!this.participantId;
  }

  join = async () => {
    await this.enter(false);
  };

  /**
   * True when a rejoin should be tried again: the network refused it, and
   * nothing was emitted. An `error` phase here would read as the call
   * ending, to the session and the recorder, with tries still left.
   */
  private async enter(rejoin: boolean): Promise<boolean> {
    if (this.snap.phase === 'joining' || this.isLive()) return false;
    this.emit({
      phase: this.attempts > 0 ? 'reconnecting' : 'joining',
      error: null,
    });
    const session = this.session;
    const res = await this.api('join', 'POST', {});
    const join = res.ok ? parseJoinResult(res.body) : null;
    if (!this.attached || session !== this.session) {
      // Unmounted or left mid-POST: the server has already seated us, and
      // nothing else knows the seat, so leave it or we show as present
      // for 60 s (or, after Leave, go live again).
      if (join) this.leaveSeat(join.participantId);
      return false;
    }
    if (!join) {
      const error = classifyRoomFailure(res.status, res.body);
      // A refusal with a reason (ended, forbidden, not configured) stands.
      if (rejoin && error === 'join_failed') return true;
      // The call is over, however it ended: release the camera and mic,
      // as ended() and connectionFailed() do. A first join keeps its
      // preview, since the lobby stays on screen.
      if (rejoin) {
        this.session += 1;
        this.stopMedia();
      }
      this.emit({ phase: 'error', error });
      return false;
    }
    this.queue = createSerialQueue();
    void this.loadChat();
    const pc = new RTCPeerConnection({
      iceServers: join.iceServers,
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;
    this.participantId = join.participantId;
    pc.addEventListener('connectionstatechange', () =>
      this.onConnectionState(pc)
    );
    // Detach, an ended meeting or a rejoin can tear this connection down
    // during any await below, and whoever did has dealt with the seat
    // (detach and rejoin send leave). Stop rather than start timers that
    // nobody clears.
    const current = () =>
      this.attached && session === this.session && this.pc === pc;

    await this.subscribeRows();
    if (!current()) return false;
    await this.awaitEffect(EFFECT_WAIT_MS);
    if (!current()) return false;
    const local: { track: MediaStreamTrack; kind: TrackKind }[] = [];
    const camera = this.sendable();
    if (this.audio) local.push({ track: this.audio, kind: 'audio' });
    if (camera) local.push({ track: camera, kind: 'video' });
    if (this.screen) local.push({ track: this.screen, kind: 'screen' });
    if (local.length) await this.publish(local);
    if (!current()) return false;

    this.timers.push(
      setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS),
      setInterval(() => this.replan(), REPLAN_TICK_MS),
      setInterval(() => void this.sampleQuality(pc), QUALITY_INTERVAL_MS)
    );
    void this.audioCtx?.resume().catch(() => {});
    this.emit({ phase: 'live' });
    void this.heartbeat();
    this.replan();
    this.announceRunningRecording();
    return false;
  }

  leave = async () => {
    this.session += 1;
    this.leaveQuietly();
    this.teardown();
    this.stopMedia();
    this.emit({ phase: 'left' });
  };

  /** "End for everyone". The server refuses anyone who cannot manage it. */
  end = async () => {
    const res = await this.api('end', 'POST', {});
    if (!res.ok) return false;
    this.ended();
    return true;
  };

  private ended() {
    this.session += 1;
    this.teardown();
    this.stopMedia();
    this.emit({ phase: 'ended' });
  }

  private teardown() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    if (this.channel) void this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.pc?.close();
    this.pc = null;
    this.participantId = null;
    this.rows.clear();
    this.pulled.clear();
    this.pending.clear();
    this.audioSender = null;
    this.videoSender = null;
    this.screenPub = null;
    this.screenGeneration = 0;
    this.pullStrikes = 0;
    if (this.layerTimer) clearTimeout(this.layerTimer);
    this.layerTimer = null;
    this.speaker = INITIAL_SPEAKER_STATE;
    this.remoteLevels = {};
    this.lossCounters = {};
    this.poor = INITIAL_POOR_TRACKER;
    // Departures still held are dropped with it: nothing fires later.
    this.presenceMemo = null;
    this.rowsLoaded = false;
    this.selfMemo = null;
    this.handWanted = false;
    this.emit({
      participants: [],
      activeSpeakerId: null,
      speaking: {},
      quality: { self: 'unknown', remote: {} },
      handRaised: false,
      liveSince: null,
    });
  }

  /** The host removed us: our seat is closed already, so no leave. */
  private removed() {
    this.session += 1;
    this.teardown();
    this.stopMedia();
    this.emit({ phase: 'removed', error: null });
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (pc !== this.pc) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      this.attempts = 0;
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      if (this.snap.phase === 'reconnecting') this.emit({ phase: 'live' });
    } else if (state === 'disconnected') {
      this.emit({ phase: 'reconnecting' });
      this.disconnectTimer ??= setTimeout(
        () => void this.reconnect(),
        DISCONNECTED_GRACE_MS
      );
    } else if (state === 'failed') {
      void this.reconnect();
    }
  }

  private async reconnect() {
    if (this.attempts >= RECONNECT_TRIES) return this.connectionFailed();
    this.attempts += 1;
    // Says so, or the server clears the recording flag while the local
    // recording carries on: nobody would be told they are being recorded.
    if (this.participantId) this.leaveSeat(this.participantId, true);
    this.teardown();
    this.emit({ phase: 'reconnecting' });
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (this.attempts - 1)));
    if (!this.attached || this.snap.phase !== 'reconnecting') return;
    // A rejoin the network refused is another attempt, and stays
    // `reconnecting` until the tries run out.
    if (await this.enter(true)) void this.reconnect();
  }

  private connectionFailed() {
    this.session += 1;
    this.leaveQuietly();
    this.teardown();
    this.stopMedia();
    this.emit({ phase: 'error', error: 'connection_failed' });
  }

  // --- participants ----------------------------------------------------

  private async subscribeRows() {
    const id = this.meetingId;
    // Since 112 a removal hides our seat, so its removed_at UPDATE never
    // reaches us; our removal row does (116). The heartbeat's 404 stays
    // the fallback, and removed() is safe to run twice.
    const onRemovalRow = (row: unknown) => {
      if (this.channel !== channel) return;
      if (isOwnRemoval(row, this.viewer.userId, id)) this.removed();
    };
    const channel = this.supabase
      .channel(`meeting-room:${id}:${Math.random().toString(36).slice(2, 10)}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'meeting_participants',
          filter: `meeting_id=eq.${id}`,
        },
        (payload: {
          eventType: string;
          new: unknown;
          old: { id?: string };
        }) => {
          if (payload.eventType === 'DELETE') {
            if (payload.old?.id) this.rows.delete(payload.old.id);
          } else {
            const row = parseParticipantRow(payload.new);
            if (row) this.onRow(row);
          }
          this.replan();
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'meetings',
          filter: `id=eq.${id}`,
        },
        (payload: { new: Partial<MeetingSummary> }) => {
          if (this.channel === channel) this.onMeetingRow(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'meeting_messages',
          filter: `meeting_id=eq.${id}`,
        },
        (payload: { new: unknown }) => this.onMessage(payload.new)
      )
      // A first removal is an INSERT; removing someone again re-upserts
      // the row (UPDATE). Not '*': Realtime applies neither RLS nor the
      // filter to DELETE events, which would reach every room.
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'meeting_removed_users',
          filter: `meeting_id=eq.${id}`,
        },
        (payload: { new: unknown }) => onRemovalRow(payload.new)
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'meeting_removed_users',
          filter: `meeting_id=eq.${id}`,
        },
        (payload: { new: unknown }) => onRemovalRow(payload.new)
      )
      .subscribe((status) => {
        // A line written between join's chat read and the subscription
        // going live reaches neither; read again once it is live (and
        // after the channel resubscribes). Merging dedupes by id. The
        // same goes for the meeting row, read in the lobby and blind
        // through a blip: a recording begun meanwhile must still be told.
        if (status === 'SUBSCRIBED' && this.channel === channel) {
          void this.loadChat();
          void this.refreshMeeting(channel);
        }
      });
    this.channel = channel;
    const { data } = await this.supabase
      .from('meeting_participants')
      .select(PARTICIPANT_COLUMNS)
      .eq('meeting_id', id)
      .is('left_at', null);
    if (this.channel !== channel) return; // torn down while reading
    for (const raw of data ?? []) {
      const row = parseParticipantRow(raw);
      if (row) this.onRow(row);
      if (this.channel !== channel) return; // removed by the host
    }
    // From here a new face is a join; before, everyone would be.
    this.rowsLoaded = true;
  }

  /**
   * The realtime channel opens on joining, so the lobby would keep what
   * it read on arrival: someone held out by a lock would stay out after
   * it lifted, and a recording started meanwhile would go unmentioned. A
   * failed read says nothing about the meeting, so it changes nothing;
   * no row is an answer, and `loadMeeting` says what it means.
   */
  private async refreshLobby() {
    const waiting = () =>
      this.snap.phase === 'lobby' && this.snap.meetingState === 'ready';
    if (!waiting()) return;
    const writes = this.meetingWrites;
    const { data, error } = await this.readMeeting();
    if (error || !waiting() || writes !== this.meetingWrites) return;
    if (data) this.onMeetingRow(data as MeetingSummary);
    else await this.loadMeeting();
  }

  private async refreshMeeting(channel: RealtimeChannel) {
    const writes = this.meetingWrites;
    const { data } = await this.readMeeting();
    if (!data || this.channel !== channel) return;
    if (writes === this.meetingWrites) {
      this.onMeetingRow(data as MeetingSummary);
    }
  }

  private onMeetingRow(row: Partial<MeetingSummary>) {
    if (row.status && row.status !== 'scheduled') return this.ended();
    this.applyMeeting(row);
  }

  /**
   * A newer view of the meeting row: a read, a realtime event or the
   * answer to an action of ours. The last two overlap, and
   * `meetingFlagNotices` announces whichever lands first.
   */
  private applyMeeting(row: Partial<MeetingSummary>) {
    this.meetingWrites += 1;
    const before = this.snap.meeting;
    const meeting = { ...before, ...row } as MeetingSummary;
    const drafts = meetingFlagNotices(before, meeting);
    if (drafts.some((d) => d.kind === 'recording_started')) {
      this.recordingAnnounced = recordingFlagOf(meeting);
    }
    this.emit({
      meeting,
      locked: !!meeting.locked_at,
      recording: this.viewRecording(
        meeting,
        this.rowsLoaded ? this.snap.participants : null
      ),
      notices: this.withNotices(drafts),
    });
  }

  /** Reaching the room with a recording under way is hearing of it. */
  private announceRunningRecording() {
    const late = lateRecordingNotices(
      this.recordingAnnounced,
      this.snap.recording,
      this.viewer.userId
    );
    this.recordingAnnounced = late.announced;
    this.notice(late.drafts);
  }

  /**
   * `present` null: the rows are not read yet (lobby, mid-join), so
   * nobody can say the recorder is gone and the flag stands.
   */
  private viewRecording(
    meeting: MeetingSummary | null,
    present: readonly ParticipantRow[] | null
  ) {
    const flag = recordingFlagOf(meeting);
    const step = stepRecordingView(this.recordingMemo, {
      flag,
      recorderPresent:
        !present || present.some((r) => r.user_id === flag?.userId),
      nowMs: Date.now(),
    });
    this.recordingMemo = step.memo;
    return step.recording;
  }

  private onRow(row: ParticipantRow) {
    this.rows.set(row.id, row);
    // Our own row was just written by the server: calibrate its clock.
    if (row.id === this.participantId) {
      this.skew = clockSkewMs(row.last_seen_at, Date.now());
      this.onSelfRow(row);
    }
  }

  /** What the host did to our seat: mute, lower our hand, remove us. */
  private onSelfRow(row: ParticipantRow) {
    const prev = this.selfMemo?.seat === row.id ? this.selfMemo.memo : null;
    const fx = selfRowEffects(prev, row, this.handWanted);
    this.selfMemo = { seat: row.id, memo: fx.memo };
    if (fx.removed) return this.removed();
    const drafts: NoticeDraft<RoomNotice>[] = [];
    if (fx.mute) {
      if (this.audio?.enabled) {
        this.audio.enabled = false;
        void this.pushState();
      }
      drafts.push({ kind: 'muted_by_host' });
    }
    if (fx.handLoweredByHost) {
      this.handWanted = false;
      drafts.push({ kind: 'hand_lowered_by_host' });
      this.emit({ handRaised: false });
    }
    this.notice(drafts);
  }

  private replan() {
    const me = this.participantId;
    if (!this.pc || !me) return;
    const present = presentParticipants(
      this.rows.values(),
      Date.now() + this.skew
    );
    const drafts: NoticeDraft<RoomNotice>[] = [];
    if (this.rowsLoaded) {
      const seen = stepPresence(
        this.presenceMemo,
        present,
        { userId: this.viewer.userId, participantId: me },
        Date.now()
      );
      this.presenceMemo = seen.memo;
      drafts.push(...seen.notices);
    }
    this.emit({
      participants: present,
      liveSince: liveSince(present),
      notices: this.withNotices(drafts),
      recording: this.viewRecording(
        this.snap.meeting,
        this.rowsLoaded ? present : null
      ),
    });
    const inFlight = new Set([...this.pulled.keys(), ...this.pending]);
    const plan = planSubscriptions(
      present,
      me,
      inFlight,
      hiddenVideo(this.tileSizes)
    );
    // A close of something still being pulled waits for the pull to land.
    const close = plan.close.filter((name) => this.pulled.has(name));
    if (plan.pull.length) {
      for (const ref of plan.pull) this.pending.add(ref.trackName);
      void this.queue.run(() => this.pull(plan.pull)).catch(() => {});
    }
    if (close.length) {
      void this.queue.run(() => this.closeRemote(close)).catch(() => {});
    }
  }

  private async heartbeat() {
    if (!this.participantId) return;
    const res = await this.api('heartbeat', 'POST', {
      participantId: this.participantId,
      audioMuted: !(this.audio?.enabled ?? false),
      videoOff: !this.video,
    });
    await this.onSeatAnswer(res);
  }

  /** A toggle shows at once for everyone instead of at the next heartbeat. */
  private async pushState() {
    if (!this.participantId) return;
    const res = await this.api('state', 'POST', {
      participantId: this.participantId,
      audioMuted: !(this.audio?.enabled ?? false),
      videoOff: !this.video,
    });
    await this.onSeatAnswer(res);
  }

  private async onSeatAnswer(res: ApiAnswer) {
    if (res.status === 409) return this.ended();
    if (res.status !== 404 || !this.isLive()) return;
    // 404: the seat was closed under us — by the host (removed_at), or
    // by joining the same meeting from another tab (join closes the
    // person's other seats). The row says which; since 112 a removal
    // hides the seat row from us, so our removal row says it too.
    const seat = this.participantId;
    const [{ data }, removed] = await Promise.all([
      this.supabase
        .from('meeting_participants')
        .select('removed_at')
        .eq('id', seat ?? '')
        .maybeSingle(),
      // Our own row only: a manager reads everyone's.
      this.viewer.userId
        ? this.isRemoved(this.viewer.userId)
        : Promise.resolve(false),
    ]);
    if (seat !== this.participantId || !this.isLive()) return;
    if (
      removed ||
      (data as { removed_at?: string | null } | null)?.removed_at
    ) {
      return this.removed();
    }
    // Same as removed(): the seat is gone, so release the camera and mic
    // and refuse a device open still in flight (it checks the session).
    this.session += 1;
    this.teardown();
    this.stopMedia();
    this.emit({ phase: 'left', error: 'seat_closed' });
  }

  // --- negotiation (always inside the queue) ---------------------------

  private publish(entries: { track: MediaStreamTrack; kind: TrackKind }[]) {
    let pc: RTCPeerConnection | null = null;
    let added: {
      track: MediaStreamTrack;
      kind: TrackKind;
      transceiver: RTCRtpTransceiver;
      name: string;
    }[] = [];
    return this.queue
      .run(async () => {
        pc = this.pc;
        const me = this.participantId;
        if (!pc || !me) return;
        const conn = pc;
        // A toggle can land inside a join's wait, and both publish. This
        // queue is serial, so whichever runs second finds the sender here,
        // and the first one's landing already put the current track on it.
        const fresh = entries.filter(
          (e) =>
            !(e.kind === 'video' && this.videoSender) &&
            !(e.kind === 'audio' && this.audioSender)
        );
        if (!fresh.length) return;
        added = fresh.map((e) => ({
          ...e,
          transceiver: conn.addTransceiver(e.track, {
            direction: 'sendonly',
            // Three camera layers, so each puller takes what its tile
            // needs; a screen share stays one sharp layer.
            sendEncodings:
              e.kind === 'video'
                ? CAMERA_ENCODINGS.map((x) => ({ ...x }))
                : e.kind === 'screen'
                  ? [{ maxBitrate: SCREEN_MAX_BITRATE }]
                  : undefined,
          }),
          name: trackNameFor(
            me,
            e.kind,
            e.kind === 'screen' ? this.screenGeneration++ : 0
          ),
        }));
        await this.offer(pc, async (sdp) => {
          const res = await this.sfu('sfu/tracks', 'POST', {
            participantId: me,
            request: {
              sessionDescription: { type: 'offer', sdp },
              tracks: added.map((a) => ({
                location: 'local',
                mid: a.transceiver.mid,
                trackName: a.name,
              })),
            },
          });
          return res;
        });
        for (const a of added) {
          if (a.kind === 'audio') this.audioSender = a.transceiver.sender;
          if (a.kind === 'video') {
            this.videoSender = a.transceiver.sender;
            // The background changed while this was in flight.
            const camera = this.sendable();
            if (camera !== a.track)
              void this.videoSender.replaceTrack(camera).catch(() => {});
          }
          if (a.kind === 'screen') {
            this.screenPub = { transceiver: a.transceiver, name: a.name };
          }
        }
      })
      .catch(() => {
        // A failed publish leaves the person in the room without that
        // track. Its transceivers would stay in the connection (a dead
        // m-line in every later offer), so stop them, and release the
        // track itself (afterFailedPublish): the mic or camera then reads
        // as off with a device error, and its toggle's turn-on path opens
        // the device and publishes again; a share reads "share" again.
        // Not on a connection already torn down: a rejoin re-publishes
        // the tracks it still holds.
        if (!pc || pc !== this.pc) return;
        for (const a of added) {
          try {
            a.transceiver.stop();
          } catch {
            // Already stopped, or the connection closed meanwhile.
          }
        }
        const published = new Set<TrackKind>();
        if (this.audioSender) published.add('audio');
        if (this.videoSender) published.add('video');
        if (this.screenPub) published.add('screen');
        const released = afterFailedPublish(
          added,
          { audio: this.audio, video: this.outgoing(), screen: this.screen },
          published
        );
        const devices = { ...this.snap.devices };
        for (const { kind, error } of released) {
          if (kind === 'video') this.stopEffect();
          this[kind]?.stop();
          this[kind] = null;
          if (error) devices[kind] = error;
        }
        this.emit({ devices });
      });
  }

  private async pull(refs: RemoteTrackRef[]) {
    const pc = this.pc;
    const me = this.participantId;
    // Set once the SFU's offer is about to be applied: from there a
    // failure has touched signalling and needs recovering (recovery.ts).
    let before: Set<RTCRtpTransceiver> | null = null;
    try {
      if (!pc || !me) return;
      // Decided once: the record below must hold what was asked for.
      const sent = new Map(
        refs.map((r) => [
          r.trackName,
          r.kind === 'video'
            ? pullSimulcast(this.tileSizes, r.participantId)
            : null,
        ])
      );
      const res = await this.sfu('sfu/tracks', 'POST', {
        participantId: me,
        request: {
          tracks: refs.map((r) => {
            const simulcast = sent.get(r.trackName) ?? null;
            return {
              location: 'remote',
              sessionId: r.sessionId,
              trackName: r.trackName,
              ...(simulcast ? { simulcast } : {}),
            };
          }),
        },
      });
      if (pc !== this.pc) return;
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        before = new Set(pc.getTransceivers());
        await pc.setRemoteDescription(res.sessionDescription);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sfu('sfu/renegotiate', 'PUT', {
          participantId: me,
          sessionDescription: { type: 'answer', sdp: answer.sdp },
        });
      }
      let resync = false;
      for (const t of res.tracks) {
        const ref = refs.find((r) => r.trackName === t.trackName);
        if (!ref || !t.mid || t.errorCode) continue;
        const transceiver = pc.getTransceivers().find((x) => x.mid === t.mid);
        if (!transceiver) continue;
        const landed =
          ref.kind === 'video'
            ? landedPull(
                sent.get(ref.trackName) ?? null,
                this.tileSizes,
                ref.participantId
              )
            : null;
        if (landed?.resync) resync = true;
        this.pulled.set(ref.trackName, {
          mid: t.mid,
          participantId: ref.participantId,
          sessionId: ref.sessionId,
          kind: ref.kind,
          track: transceiver.receiver.track,
          receiver: transceiver.receiver,
          rid: landed?.rid ?? null,
        });
      }
      this.pullStrikes = 0;
      // A tile resized while this pull was in flight: move it now.
      if (resync) this.scheduleLayers();
    } catch {
      if (pc && before && pc === this.pc) await this.recoverPull(pc, before);
    } finally {
      // Anything not pulled is retried on the next plan.
      for (const r of refs) this.pending.delete(r.trackName);
      this.emit();
    }
  }

  /** A pull failed after touching signalling: undo it, then retry or rejoin. */
  private async recoverPull(
    pc: RTCPeerConnection,
    before: Set<RTCRtpTransceiver>
  ) {
    if (needsPullRollback(pc.signalingState)) {
      await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    }
    // The rollback removes what the offer created; with the answer
    // already applied (its PUT failed) they stay and must be stopped.
    for (const t of pc.getTransceivers()) {
      if (before.has(t)) continue;
      try {
        t.stop();
      } catch {
        // Already stopped, or the connection closed meanwhile.
      }
    }
    if (pc !== this.pc) return;
    const next = afterPullStrike(this.pullStrikes, pc.signalingState);
    this.pullStrikes = next.strikes;
    if (!next.rejoin) return;
    const budget = admitPullRejoin(this.pullRejoins, Date.now());
    this.pullRejoins = budget.rejoins;
    // Not awaited: this runs inside the queue, and the rejoin builds its own.
    if (budget.admit) void this.reconnect();
    else this.connectionFailed();
  }

  private async closeRemote(names: string[]) {
    const pc = this.pc;
    if (!pc) return;
    const transceivers = names
      .map((n) => this.pulled.get(n)?.mid)
      .map((mid) => pc.getTransceivers().find((t) => t.mid === mid))
      .filter((t): t is RTCRtpTransceiver => !!t);
    for (const n of names) this.pulled.delete(n);
    this.emit();
    if (transceivers.length) await this.negotiateClose(transceivers, []);
  }

  /**
   * Negotiated close: stop, offer, PUT tracks/close, apply the answer.
   * Call it only from inside a queued task: queueing it again from
   * there would wait on the very task that awaits it.
   */
  private async negotiateClose(
    transceivers: RTCRtpTransceiver[],
    closedLocalTrackNames: string[]
  ) {
    const pc = this.pc;
    const me = this.participantId;
    if (!pc || !me) return;
    const mids = transceivers.map((t) => t.mid).filter((m): m is string => !!m);
    for (const t of transceivers) t.stop();
    if (!mids.length) return;
    await this.offer(pc, (sdp) =>
      this.sfu('sfu/tracks/close', 'PUT', {
        participantId: me,
        request: {
          tracks: mids.map((mid) => ({ mid })),
          force: false,
          sessionDescription: { type: 'offer', sdp },
        },
        ...(closedLocalTrackNames.length ? { closedLocalTrackNames } : {}),
      })
    );
  }

  /** createOffer → setLocalDescription → send → apply the answer, rolling back on failure. */
  private async offer(
    pc: RTCPeerConnection,
    send: (sdp: string) => Promise<TracksResult>
  ) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    try {
      const res = await send(pc.localDescription?.sdp ?? offer.sdp ?? '');
      if (pc !== this.pc) return;
      if (!res.sessionDescription || res.sessionDescription.type !== 'answer') {
        throw new Error(res.errorCode ?? 'no_answer');
      }
      await pc.setRemoteDescription(res.sessionDescription);
    } catch (err) {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }
      throw err;
    }
  }

  // --- v2: notices ---------------------------------------------------

  private withNotices(drafts: NoticeDraft<RoomNotice>[]): RoomNotice[] {
    return pushNotices<RoomNotice>(
      this.snap.notices,
      drafts,
      () => `n${++this.noticeSeq}`
    );
  }

  private notice(drafts: NoticeDraft<RoomNotice>[]) {
    if (drafts.length) this.emit({ notices: this.withNotices(drafts) });
  }

  dismissNotices = (ids: string[]) => {
    const notices = dismissNotices(this.snap.notices, ids);
    if (notices !== this.snap.notices) this.emit({ notices });
  };

  // --- v2: devices ---------------------------------------------------

  /** A mic or camera unplugged mid-call: off, and the default next time. */
  private onTrackEnded(kind: 'audio' | 'video', track: MediaStreamTrack) {
    if (this[kind] !== track) return; // replaced or turned off meanwhile
    if (kind === 'video') this.stopEffect();
    this[kind] = null;
    const sender = kind === 'audio' ? this.audioSender : this.videoSender;
    void sender?.replaceTrack(null).catch(() => {});
    // In memory only: the stored choice comes back when it is plugged in.
    const key = kind === 'audio' ? 'audioinput' : 'videoinput';
    this.prefs = { ...this.prefs, [key]: null };
    this.emit({
      selectedDevices: { ...this.snap.selectedDevices, [key]: null },
      notices: this.withNotices([{ kind: 'device_lost', device: kind }]),
    });
    void this.pushState();
    void this.refreshDevices();
  }

  private async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices
      .enumerateDevices()
      .catch(() => [] as MediaDeviceInfo[]);
    if (!this.attached) return;
    const deviceOptions = deviceOptionsFrom(list);
    this.emit({
      deviceOptions,
      selectedDevices: effectiveSelection(this.prefs, deviceOptions),
    });
  }

  selectDevice = async (kind: MediaDeviceKind, deviceId: string) => {
    if (kind === 'audiooutput' && !this.snap.canSelectOutput) return;
    this.prefs = { ...this.prefs, [kind]: deviceId || null };
    try {
      localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Private mode or full storage: the choice lasts this visit only.
    }
    // The output is applied by the screen's audio elements (setSinkId),
    // which read it from here.
    this.emit({
      selectedDevices: {
        ...this.snap.selectedDevices,
        [kind]: deviceId || null,
      },
    });
    if (kind === 'audiooutput') return;
    const k = kind === 'audioinput' ? 'audio' : 'video';
    const current = this[k];
    // Off: the choice applies the next time it is turned on.
    if (!current || this.opening.has(k)) return;
    this.opening.add(k);
    // A camera refused as busy (the old one is still live): the old one
    // goes, the camera reads as off, and the open is tried once more.
    let released = false;
    const release = () => {
      if (this.video !== current) return false;
      released = true;
      this.stopEffect();
      this.video = null;
      current.stop();
      void this.videoSender?.replaceTrack(null).catch(() => {});
      this.emit();
      return true;
    };
    const track = await this.open(
      k,
      k === 'video' ? release : undefined
    ).finally(() => this.opening.delete(k));
    if (released) {
      // The camera is off now; the new one turns it back on, or it stays
      // off (open() showed why) and everyone sees the avatar.
      if (track && !this.video) {
        this.video = track;
        this.emit();
        await this.awaitEffect(EFFECT_WAIT_MS);
        const out = this.sendable();
        if (out) await this.videoSender?.replaceTrack(out).catch(() => {});
      } else track?.stop();
      void this.pushState();
      return;
    }
    if (!track) return; // open() showed why; the old device keeps working
    if (this[k] !== current) {
      track.stop();
      return;
    }
    if (k === 'audio') track.enabled = current.enabled;
    // A background keeps its output track: only what feeds it changes.
    const processor = k === 'video' ? this.processor : null;
    if (processor) {
      const fed = await processor.setInput(track).then(
        () => true,
        () => false
      );
      // Its <video> now holds the new camera, which sent nothing.
      if (!fed && processor === this.processor) this.effectFailed();
      if (!fed || processor !== this.processor) {
        track.stop();
        return;
      }
    } else {
      // Same sender, new source: no renegotiation, nobody re-pulls.
      const sender = k === 'audio' ? this.audioSender : this.videoSender;
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }
    if (this[k] !== current) {
      track.stop();
      return;
    }
    this[k] = track;
    current.stop();
    this.emit();
  };

  // --- v2: hand, chat, reactions, moderation -------------------------

  toggleHand = async () => {
    const participantId = this.participantId;
    if (!participantId) return;
    const want = !this.snap.handRaised;
    this.handWanted = want;
    const res = await this.api('state', 'POST', {
      participantId,
      handRaised: want,
    });
    if (participantId !== this.participantId) return;
    if (res.ok) this.emit({ handRaised: want });
    else {
      this.handWanted = this.snap.handRaised;
      await this.onSeatAnswer(res);
    }
  };

  sendChat = async (body: string) => {
    const text = body.trim();
    if (!text || text.length > CHAT_MAX) return false;
    const res = await this.api('messages', 'POST', {
      kind: 'chat',
      body: text,
    });
    if (res.ok) this.onMessage((res.body as { message?: unknown })?.message);
    return res.ok;
  };

  sendReaction = async (emoji: MeetingReaction) => {
    const res = await this.api('messages', 'POST', {
      kind: 'reaction',
      body: emoji,
    });
    if (res.ok) this.onMessage((res.body as { message?: unknown })?.message);
  };

  moderate = async (target: ParticipantId, action: ModerationAction) => {
    const res = await this.api('moderate', 'POST', { target, action });
    return res.ok;
  };

  moderateAll = async (action: BulkModerationAction) => {
    const res = await this.api('moderate', 'POST', { action });
    return res.ok;
  };

  setLocked = async (locked: boolean) => {
    const res = await this.api('lock', 'POST', { locked });
    if (!res.ok) return lockFailure(res.status, res.body);
    const answer = res.body as { locked_at?: string | null } | null;
    this.applyMeeting({ locked_at: answer?.locked_at ?? null });
    return 'ok' as const;
  };

  invite = async (userIds: string[]) => {
    const res = await this.api('invite', 'POST', { userIds });
    const invited = (res.body as { invited?: unknown } | null)?.invited;
    return res.ok && Array.isArray(invited) ? (invited as string[]) : null;
  };

  setRecordingFlag = async (on: boolean) => {
    const res = await this.api('recording', 'POST', { recording: on });
    if (!res.ok) return recordingFailure(res.status, res.body);
    const answer = res.body as {
      recording_started_at?: string | null;
      recording_by?: string | null;
    } | null;
    this.applyMeeting({
      recording_started_at: answer?.recording_started_at ?? null,
      recording_by: answer?.recording_by ?? null,
    });
    return 'ok' as const;
  };

  private async loadChat() {
    const res = await this.api('messages?kind=chat', 'GET', null);
    const list = (res.body as { messages?: unknown } | null)?.messages;
    if (!res.ok || !Array.isArray(list)) return;
    const incoming = list
      .map(parseMeetingMessage)
      .flatMap((m) => (m?.kind === 'chat' ? [m.message] : []));
    const chat = mergeChat(this.snap.chat, incoming);
    if (chat !== this.snap.chat) this.emit({ chat });
  }

  /** One message, from realtime or our own POST (the two overlap). */
  private onMessage(raw: unknown) {
    const m = parseMeetingMessage(raw);
    if (!m) return;
    if (m.kind === 'chat') {
      const chat = mergeChat(this.snap.chat, [m.message]);
      if (chat !== this.snap.chat) this.emit({ chat });
      return;
    }
    const held = addReaction(this.reactionsHeld, m.reaction, Date.now());
    if (held === this.reactionsHeld) return;
    this.reactionsHeld = held;
    this.emit({ reactions: held.map((h) => h.event) });
  }

  // --- v2: simulcast layers ------------------------------------------

  setTileSizes = (sizes: Record<ParticipantId, TileSize>) => {
    if (sameRecord(sizes, this.tileSizes)) return;
    this.tileSizes = { ...sizes };
    this.scheduleLayers();
  };

  private scheduleLayers() {
    if (this.layerTimer) clearTimeout(this.layerTimer);
    this.layerTimer = setTimeout(() => {
      this.layerTimer = null;
      // Hidden tiles close their camera, shown ones pull it again …
      this.replan();
      // … and every pulled camera moves to its tile's layer, queued
      // behind any negotiation in flight.
      void this.queue.run(() => this.updateLayers()).catch(() => {});
    }, LAYER_DEBOUNCE_MS);
  }

  private async updateLayers() {
    const pc = this.pc;
    const me = this.participantId;
    if (!pc || !me) return;
    const cameras = [...this.pulled.entries()]
      .filter(([, p]) => p.kind === 'video')
      .map(([trackName, p]) => ({ trackName, ...p }));
    const updates = planLayerUpdates(this.tileSizes, cameras);
    if (!updates.length) return;
    let res: TracksResult;
    try {
      res = await this.sfu('sfu/tracks/update', 'PUT', {
        participantId: me,
        request: { tracks: updates },
      });
    } catch {
      return; // rid stays as it was, so the next change retries
    }
    if (pc !== this.pc) return;
    if (res.requiresImmediateRenegotiation && res.sessionDescription) {
      const before = new Set(pc.getTransceivers());
      try {
        await pc.setRemoteDescription(res.sessionDescription);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sfu('sfu/renegotiate', 'PUT', {
          participantId: me,
          sessionDescription: { type: 'answer', sdp: answer.sdp },
        });
      } catch {
        // The SFU is left with an offer nobody answered, as after a
        // failed pull: the same rollback, strike and rejoin budget.
        if (pc === this.pc) await this.recoverPull(pc, before);
        return;
      }
    }
    const refused = new Set(
      res.tracks.filter((t) => t.errorCode).map((t) => t.mid ?? t.trackName)
    );
    for (const u of updates) {
      const p = this.pulled.get(u.trackName);
      if (
        p &&
        p.mid === u.mid &&
        !refused.has(u.mid) &&
        !refused.has(u.trackName)
      ) {
        p.rid = u.simulcast.preferredRid;
      }
    }
  }

  // --- v2: levels and quality ----------------------------------------

  private dropAnalyser() {
    this.analyser?.source.disconnect();
    this.analyser = null;
  }

  /** Our mic level, 0..1, from an AnalyserNode on the current track. */
  private localLevel(): number {
    const track = this.audio;
    if (!track || !track.enabled || track.readyState !== 'live') return 0;
    if (this.analyser?.track !== track) {
      this.dropAnalyser();
      const Ctx =
        typeof window !== 'undefined'
          ? (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext)
          : undefined;
      if (!Ctx) return 0;
      try {
        this.audioCtx ??= new Ctx();
        const source = this.audioCtx.createMediaStreamSource(
          new MediaStream([track])
        );
        const node = this.audioCtx.createAnalyser();
        node.fftSize = 512;
        source.connect(node); // never to the speakers: no local echo
        this.analyser = {
          track,
          source,
          node,
          buf: new Float32Array(node.fftSize),
        };
      } catch {
        return 0;
      }
    }
    this.analyser.node.getFloatTimeDomainData(this.analyser.buf);
    return rmsLevel(this.analyser.buf);
  }

  /** One reading at a time: getStats can outlast a level tick. */
  private async readRemoteLevels() {
    const pc = this.pc;
    if (!pc || this.remoteLevelsBusy) return;
    this.remoteLevelsBusy = true;
    const stats = await pc.getStats().catch(() => null);
    this.remoteLevelsBusy = false;
    if (!stats || pc !== this.pc) return;
    const byMid: Record<string, ParticipantId> = {};
    for (const p of this.pulled.values()) {
      if (p.kind === 'audio') byMid[p.mid] = p.participantId;
    }
    const reports: StatLike[] = [];
    stats.forEach((r) => reports.push(r as StatLike));
    this.remoteLevels = inboundAudioLevels(reports, byMid);
  }

  private sampleLevels() {
    void this.readRemoteLevels();
    const now = Date.now();
    const local = this.localLevel();
    let { activeSpeakerId, speaking } = this.snap;
    const me = this.participantId;
    if (me && this.pc) {
      const levels: Record<ParticipantId, number> = {};
      for (const p of this.snap.participants) levels[p.id] = 0;
      levels[me] = local;
      const muted = new Set(
        this.snap.participants.filter((p) => p.audio_muted).map((p) => p.id)
      );
      const perfNow = performance.now();
      for (const p of this.pulled.values()) {
        if (p.kind !== 'audio' || !(p.participantId in levels)) continue;
        const silent = muted.has(p.participantId);
        levels[p.participantId] = Math.max(
          levels[p.participantId],
          remoteLevel(
            p.receiver.getSynchronizationSources(),
            silent,
            perfNow,
            performance.timeOrigin
          ),
          silent ? 0 : (this.remoteLevels[p.participantId] ?? 0)
        );
      }
      const step = stepSpeaker(this.speaker, levels, now);
      this.speaker = step.state;
      activeSpeakerId = step.activeSpeakerId;
      speaking = step.speaking;
    }
    const patch: Partial<CallSnapshot> = {
      ...levelPatch(this.snap, {
        activeSpeakerId,
        speaking,
        localAudioLevel: local,
      }),
    };
    const held = pruneReactions(this.reactionsHeld, now);
    if (held !== this.reactionsHeld) {
      this.reactionsHeld = held;
      patch.reactions = held.map((h) => h.event);
    }
    if (Object.keys(patch).length) this.emit(patch);
  }

  private async sampleQuality(pc: RTCPeerConnection) {
    const stats = await pc.getStats().catch(() => null);
    if (!stats || pc !== this.pc) return;
    const byMid: Record<string, ParticipantId> = {};
    for (const p of this.pulled.values()) byMid[p.mid] = p.participantId;
    const reports: StatLike[] = [];
    stats.forEach((r) => reports.push(r as StatLike));
    const sum = summarizeStats(reports, byMid, this.lossCounters);
    this.lossCounters = sum.counters;
    const self = classifyQuality(sum.self);
    const remote: Record<ParticipantId, Quality> = {};
    for (const [id, sample] of Object.entries(sum.remote)) {
      remote[id] = classifyQuality(sample);
    }
    const poor = stepPoorTracker(this.poor, self, Date.now());
    this.poor = poor.state;
    const patch: Partial<CallSnapshot> = {};
    const prev = this.snap.quality;
    if (prev.self !== self || !sameRecord(prev.remote, remote)) {
      patch.quality = { self, remote };
    }
    if (poor.notify)
      patch.notices = this.withNotices([{ kind: 'quality_poor' }]);
    if (Object.keys(patch).length) this.emit(patch);
  }

  // --- transport -------------------------------------------------------

  private async sfu(path: string, method: string, body: unknown) {
    const res = await this.api(path, method, body);
    const parsed = parseTracksResult(res.body);
    if (!res.ok || parsed.errorCode) {
      throw new Error(parsed.errorCode ?? `http_${res.status}`);
    }
    return parsed;
  }

  private async api(
    path: string,
    method: string,
    body: unknown,
    keepalive = false
  ): Promise<ApiAnswer> {
    try {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(this.meetingId)}/${path}`,
        method === 'GET'
          ? { method }
          : {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              keepalive,
            }
      );
      const json: unknown = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: json };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }
}

export interface MeetingCall extends CallSnapshot, CallActionsV2 {
  join: () => Promise<void>;
  returnToLobby: () => Promise<void>;
  leave: () => Promise<void>;
  end: () => Promise<boolean>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
}

/** A held engine's call. The session decides how long the engine lives. */
export function useCallOf(engine: MeetingCallEngine): MeetingCall {
  const snap = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot
  );
  return useMemo(() => engine.toCall(snap), [engine, snap]);
}

function readEffectPref(): BackgroundEffect {
  try {
    return parseEffectPref(localStorage.getItem(EFFECT_PREF_KEY));
  } catch {
    return { kind: 'none' };
  }
}

function readDevicePrefs(): DevicePrefs {
  try {
    return parseDevicePrefs(localStorage.getItem(DEVICE_PREFS_KEY));
  } catch {
    return parseDevicePrefs(null);
  }
}
