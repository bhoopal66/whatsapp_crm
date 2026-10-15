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
//   the avatar from the row's `video_off`, which we push with an
//   immediate heartbeat on every toggle.
// - The screen share is episodic, so stopping it closes its SFU track
//   (the featured tile must go away for everyone) and the next share
//   publishes a new generation of the name (`trackNameFor`).
// - ICE `failed`, or `disconnected` for 15 s, rejoins from scratch: a new
//   participant row and session, the same local tracks. Up to 3 tries.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  classifyMediaError,
  isShareCancelled,
  tracksToRelease,
} from '@/lib/meetings/room/devices';
import type { DeviceError } from '@/lib/meetings/room/devices';
import {
  clockSkewMs,
  HEARTBEAT_INTERVAL_MS,
  presentParticipants,
} from '@/lib/meetings/room/presence';
import { createSerialQueue } from '@/lib/meetings/room/queue';
import {
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
import { createClient } from '@/lib/supabase/client';

export type CallPhase =
  'lobby' | 'joining' | 'live' | 'reconnecting' | 'left' | 'ended' | 'error';

export interface MeetingSummary {
  id: string;
  title: string;
  status: string;
  host_user_id: string;
}

export interface CallSnapshot {
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

interface Pulled {
  mid: string;
  participantId: string;
  kind: TrackKind;
  track: MediaStreamTrack;
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
  private attached = false;
  // Bumped on every attach/detach. React's dev double-mount runs
  // attach → detach → attach; a getUserMedia from the first attach that
  // resolves after the second must stop its track, not keep the camera on.
  private epoch = 0;

  // Lazily: the engine is also constructed during the server render.
  private get supabase(): SupabaseClient {
    return createClient();
  }

  constructor(private readonly meetingId: string) {
    this.snap = {
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
    void this.loadMeeting();
    void this.startPreview();
  }

  /** Unmount: leave the call and release every device. */
  detach() {
    this.attached = false;
    this.epoch += 1;
    this.leaveQuietly();
    this.teardown();
    this.stopMedia();
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'audio'
          ? { audio: { echoCancellation: true, noiseSuppression: true } }
          : { video: { width: { ideal: 1280 }, height: { ideal: 720 } } }
      );
      const track = stream.getTracks()[0] ?? null;
      if (!this.attached || epoch !== this.epoch) {
        track?.stop();
        return null;
      }
      this.setDevice(kind, null);
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
  }

  /** After leaving: back to the lobby, devices reopened. */
  returnToLobby = async () => {
    if (this.isLive() || this.snap.phase === 'joining') return;
    this.attempts = 0;
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
      if (this.audio && this.isLive()) {
        await this.publish([{ track: this.audio, kind: 'audio' }]);
      }
    } else {
      this.audio.enabled = !this.audio.enabled;
    }
    this.emit();
    void this.heartbeat();
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
    void this.heartbeat();
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
    const res = await this.api('join', 'POST', {});
    const join = res.ok ? parseJoinResult(res.body) : null;
    if (!this.attached) {
      // Unmounted mid-POST: the server has already seated us, and nothing
      // else knows the seat, so leave it or we show as present for 60 s.
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
    const current = () => this.attached && this.pc === pc;

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
      setInterval(() => this.replan(), REPLAN_TICK_MS)
    );
    this.emit({ phase: 'live' });
    void this.heartbeat();
    this.replan();
  };

  leave = async () => {
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
    this.videoSender = null;
    this.screenPub = null;
    this.screenGeneration = 0;
    this.pullStrikes = 0;
    this.emit({ participants: [] });
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
    if (this.attempts >= RECONNECT_TRIES) {
      this.leaveQuietly();
      this.teardown();
      this.emit({ phase: 'error', error: 'connection_failed' });
      return;
    }
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
    }
  }

  private onRow(row: ParticipantRow) {
    this.rows.set(row.id, row);
    // Our own row was just written by the server: calibrate its clock.
    if (row.id === this.participantId) {
      this.skew = clockSkewMs(row.last_seen_at, Date.now());
    }
  }

  private replan() {
    const me = this.participantId;
    if (!this.pc || !me) return;
    const present = presentParticipants(
      this.rows.values(),
      Date.now() + this.skew
    );
    this.emit({ participants: present });
    const inFlight = new Set([...this.pulled.keys(), ...this.pending]);
    const plan = planSubscriptions(present, me, inFlight);
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
    if (res.status === 409) this.ended();
    // 404: the seat was closed under us, almost always by joining the
    // same meeting from another tab (join closes the person's other seats).
    else if (res.status === 404 && this.isLive()) {
      this.teardown();
      this.emit({ phase: 'left', error: 'seat_closed' });
    }
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
          if (a.kind === 'video') this.videoSender = a.transceiver.sender;
          if (a.kind === 'screen') {
            this.screenPub = { transceiver: a.transceiver, name: a.name };
          }
        }
      })
      .catch(() => {
        // A failed publish leaves the person in the room without that
        // track; the device toggle can try again. Its transceivers would
        // stay in the connection (a dead m-line in every later offer), so
        // stop them. A share with no screenPub leaves stopShare nothing to
        // close, so end the capture too and the button reads "share"
        // again. Not on a connection already torn down: a rejoin
        // re-publishes the share it still holds.
        if (!pc || pc !== this.pc) return;
        for (const a of added) {
          try {
            a.transceiver.stop();
          } catch {
            // Already stopped, or the connection closed meanwhile.
          }
          if (a.kind === 'screen' && this.screen === a.track) {
            a.track.stop();
            this.screen = null;
          }
        }
        this.emit();
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
          tracks: refs.map((r) => ({
            location: 'remote',
            sessionId: r.sessionId,
            trackName: r.trackName,
          })),
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
          kind: ref.kind,
          track: transceiver.receiver.track,
        });
      }
      this.pullStrikes = 0;
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
    // Not awaited: this runs inside the queue, and the rejoin builds its own.
    if (next.rejoin) void this.reconnect();
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
        {
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

export interface MeetingCall extends CallSnapshot {
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
  };
}
