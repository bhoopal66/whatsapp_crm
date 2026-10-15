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
// (quality.ts). Chat, reactions, hands and moderation go through the
// API; what the host did to our seat arrives on our own row
// (notices.ts). Every decision is a pure function under
// lib/meetings/room, tested there; this file only wires them.

import { useEffect, useState, useSyncExternalStore } from 'react';

import { useAuth } from '@/hooks/use-auth';
import type { AccountRole } from '@/lib/auth/roles';
import {
  addReaction,
  mergeChat,
  parseMeetingMessage,
  pruneReactions,
  type HeldReaction,
} from '@/lib/meetings/room/chat';
import {
  dismissNotices,
  presenceNotices,
  pushNotices,
  selfRowEffects,
  type NoticeDraft,
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
  planLayerUpdates,
  simulcastFor,
  tileSizeOf,
  type Rid,
} from '@/lib/meetings/room/simulcast';
import {
  INITIAL_SPEAKER_STATE,
  levelPatch,
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
  isShareCancelled,
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
/** Tile sizes settle (a resize drags through many) before a layer switch. */
const LAYER_DEBOUNCE_MS = 300;
/** A shared screen is text: one layer, enough bits to stay legible. */
const SCREEN_MAX_BITRATE = 2_500_000;
const CHAT_MAX = 2000;

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

class MeetingCallEngine {
  private listeners = new Set<() => void>();
  private snap: CallSnapshot;
  private queue = createSerialQueue();
  private pc: RTCPeerConnection | null = null;
  private participantId: string | null = null;
  private rows = new Map<string, ParticipantRow>();
  private pulled = new Map<string, Pulled>();
  private pending = new Set<string>();
  private audio: MediaStreamTrack | null = null;
  private video: MediaStreamTrack | null = null;
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
  /** Who was present at the last plan; null until the initial read lands. */
  private presenceUsers: Set<string> | null = null;
  private rowsLoaded = false;
  private selfMemo: { seat: string; memo: SelfRowMemo } | null = null;
  /** The hand we last asked for, so our own lowering is not the host's. */
  private handWanted = false;
  private reactionsHeld: HeldReaction[] = [];
  private noticeSeq = 0;
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

  constructor(private readonly meetingId: string) {
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
      localVideo: this.video,
      localScreen: this.screen,
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
    this.emit({
      selectedDevices: { ...this.prefs },
      canSelectOutput:
        typeof HTMLMediaElement !== 'undefined' &&
        'setSinkId' in HTMLMediaElement.prototype,
    });
    navigator.mediaDevices?.addEventListener?.(
      'devicechange',
      this.onDeviceChange
    );
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_TICK_MS);
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

  private leaveSeat(participantId: string) {
    void this.api('leave', 'POST', { participantId }, true);
  }

  private async loadMeeting() {
    const { data, error } = await this.supabase
      .from('meetings')
      .select('id, title, status, host_user_id')
      .eq('id', this.meetingId)
      .maybeSingle();
    // An error reads as missing too: the room cannot be shown either way.
    this.emit(
      data && !error
        ? { meetingState: 'ready', meeting: data as MeetingSummary }
        : { meetingState: 'missing' }
    );
    this.updateCanModerate();
  }

  // --- devices ---------------------------------------------------------

  private async open(
    kind: 'audio' | 'video'
  ): Promise<MediaStreamTrack | null> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      this.setDevice(kind, 'unsupported');
      return null;
    }
    const epoch = this.epoch;
    const chosen = this.prefs[kind === 'audio' ? 'audioinput' : 'videoinput'];
    try {
      const stream = await navigator.mediaDevices
        .getUserMedia(mediaConstraints(kind, chosen))
        .catch((err) => {
          // The chosen device is gone (unplugged since): the default.
          if (!chosen || classifyMediaError(err) !== 'not_found') throw err;
          return navigator.mediaDevices.getUserMedia(
            mediaConstraints(kind, null)
          );
        });
      const track = stream.getTracks()[0] ?? null;
      if (!this.attached || epoch !== this.epoch) {
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
    for (const t of [this.audio, this.video, this.screen]) t?.stop();
    this.audio = this.video = this.screen = null;
  }

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
      if (this.isLive()) {
        if (this.videoSender) await this.videoSender.replaceTrack(track);
        else await this.publish([{ track, kind: 'video' }]);
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
    if (!this.attached) {
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
    if (this.snap.phase === 'joining' || this.isLive()) return;
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
      return;
    }
    if (!join) {
      this.emit({
        phase: 'error',
        error: classifyRoomFailure(res.status, res.body),
      });
      return;
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
    if (!current()) return;
    const local: { track: MediaStreamTrack; kind: TrackKind }[] = [];
    if (this.audio) local.push({ track: this.audio, kind: 'audio' });
    if (this.video) local.push({ track: this.video, kind: 'video' });
    if (this.screen) local.push({ track: this.screen, kind: 'screen' });
    if (local.length) await this.publish(local);
    if (!current()) return;

    this.timers.push(
      setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS),
      setInterval(() => this.replan(), REPLAN_TICK_MS),
      setInterval(() => void this.sampleQuality(pc), QUALITY_INTERVAL_MS)
    );
    void this.audioCtx?.resume().catch(() => {});
    this.emit({ phase: 'live' });
    void this.heartbeat();
    this.replan();
  };

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
    this.lossCounters = {};
    this.poor = INITIAL_POOR_TRACKER;
    this.presenceUsers = null;
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
    this.leaveQuietly();
    this.teardown();
    this.emit({ phase: 'reconnecting' });
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (this.attempts - 1)));
    if (!this.attached || this.snap.phase !== 'reconnecting') return;
    await this.join();
    // A rejoin the network refused is another attempt; a refusal with a
    // reason (ended, not configured, forbidden) stands. (Re-read: join
    // changed the snapshot, which TS cannot see through the await.)
    const after: CallSnapshot = this.getSnapshot();
    if (after.phase === 'error' && after.error === 'join_failed') {
      void this.reconnect();
    }
  }

  private connectionFailed() {
    this.session += 1;
    this.leaveQuietly();
    this.teardown();
    this.emit({ phase: 'error', error: 'connection_failed' });
  }

  // --- participants ----------------------------------------------------

  private async subscribeRows() {
    const id = this.meetingId;
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
        (payload: { new: { status?: string } }) => {
          if (payload.new?.status && payload.new.status !== 'scheduled')
            this.ended();
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
      .subscribe();
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
      const seen = presenceNotices(this.presenceUsers, present, {
        userId: this.viewer.userId,
        participantId: me,
      });
      this.presenceUsers = seen.users;
      drafts.push(...seen.notices);
    }
    this.emit({
      participants: present,
      liveSince: liveSince(present),
      notices: this.withNotices(drafts),
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
    // person's other seats). The row says which.
    const seat = this.participantId;
    const { data } = await this.supabase
      .from('meeting_participants')
      .select('removed_at')
      .eq('id', seat ?? '')
      .maybeSingle();
    if (seat !== this.participantId || !this.isLive()) return;
    if ((data as { removed_at?: string | null } | null)?.removed_at) {
      return this.removed();
    }
    this.teardown();
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
        added = entries.map((e) => ({
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
          if (a.kind === 'video') this.videoSender = a.transceiver.sender;
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
          { audio: this.audio, video: this.video, screen: this.screen },
          published
        );
        const devices = { ...this.snap.devices };
        for (const { kind, error } of released) {
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
      const res = await this.sfu('sfu/tracks', 'POST', {
        participantId: me,
        request: {
          tracks: refs.map((r) => {
            const simulcast =
              r.kind === 'video'
                ? simulcastFor(tileSizeOf(this.tileSizes, r.participantId))
                : null;
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
      for (const t of res.tracks) {
        const ref = refs.find((r) => r.trackName === t.trackName);
        if (!ref || !t.mid || t.errorCode) continue;
        const transceiver = pc.getTransceivers().find((x) => x.mid === t.mid);
        if (!transceiver) continue;
        this.pulled.set(ref.trackName, {
          mid: t.mid,
          participantId: ref.participantId,
          sessionId: ref.sessionId,
          kind: ref.kind,
          track: transceiver.receiver.track,
          receiver: transceiver.receiver,
          rid:
            ref.kind === 'video'
              ? (simulcastFor(tileSizeOf(this.tileSizes, ref.participantId))
                  ?.preferredRid ?? null)
              : null,
        });
      }
      this.pullStrikes = 0;
      // A tile resized while this pull was in flight.
      if (refs.some((r) => r.kind === 'video')) this.scheduleLayers();
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
    const track = await this.open(k).finally(() => this.opening.delete(k));
    if (!track) return; // open() showed why; the old device keeps working
    if (this[k] !== current) {
      track.stop();
      return;
    }
    if (k === 'audio') track.enabled = current.enabled;
    // Same sender, new source: no renegotiation, nobody re-pulls.
    const sender = k === 'audio' ? this.audioSender : this.videoSender;
    if (sender) await sender.replaceTrack(track).catch(() => {});
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
      try {
        await pc.setRemoteDescription(res.sessionDescription);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sfu('sfu/renegotiate', 'PUT', {
          participantId: me,
          sessionDescription: { type: 'answer', sdp: answer.sdp },
        });
      } catch {
        if (pc === this.pc && needsPullRollback(pc.signalingState)) {
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }
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

  private sampleLevels() {
    const now = Date.now();
    const local = this.localLevel();
    let { activeSpeakerId, speaking } = this.snap;
    const me = this.participantId;
    if (me && this.pc) {
      const levels: Record<ParticipantId, number> = {};
      for (const p of this.snap.participants) levels[p.id] = 0;
      levels[me] = local;
      for (const p of this.pulled.values()) {
        if (p.kind !== 'audio' || !(p.participantId in levels)) continue;
        for (const src of p.receiver.getSynchronizationSources()) {
          levels[p.participantId] = Math.max(
            levels[p.participantId],
            src.audioLevel ?? 0
          );
        }
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

/** The call for one meeting, owned by the room screen (lobby and room alike). */
export function useMeetingCall(meetingId: string): MeetingCall {
  const [engine] = useState(() => new MeetingCallEngine(meetingId));
  const { user, accountRole } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    engine.setViewer(userId, accountRole);
  }, [engine, userId, accountRole]);
  const snap = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot
  );

  useEffect(() => {
    engine.attach();
    const onHide = () => engine.leaveQuietly();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      engine.detach();
    };
  }, [engine]);

  return {
    ...snap,
    join: engine.join,
    returnToLobby: engine.returnToLobby,
    leave: engine.leave,
    end: engine.end,
    toggleMic: engine.toggleMic,
    toggleCamera: engine.toggleCamera,
    toggleScreen: engine.toggleScreen,
    selectDevice: engine.selectDevice,
    toggleHand: engine.toggleHand,
    sendChat: engine.sendChat,
    sendReaction: engine.sendReaction,
    moderate: engine.moderate,
    setTileSizes: engine.setTileSizes,
    dismissNotices: engine.dismissNotices,
  };
}

function readDevicePrefs(): DevicePrefs {
  try {
    return parseDevicePrefs(localStorage.getItem(DEVICE_PREFS_KEY));
  } catch {
    return parseDevicePrefs(null);
  }
}
