'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import {
  pickSaveSink,
  startCapture,
  type MeetingCapture,
  type SaveSink,
} from '@/lib/meetings/recording/capture';
import {
  createRecorderMachine,
  pickMimeType,
  recordingFileName,
  recordingLayout,
  type RecorderMachine,
} from '@/lib/meetings/recording/plan';
import { isInCall } from '@/lib/meetings/session/session';

import { ConfirmDialog } from '../room/confirm-dialog';
import { useWorkspaceMembers } from '../use-workspace-members';
import type { ActiveCall } from './meeting-session-provider';

type Say = (key: string) => string;

/** The recorder's state outside React: it outlives every render. */
function createLive() {
  let call: ActiveCall['call'];
  let say: Say = (key) => key;
  let redraw: (() => void) | undefined;
  let capture0: MeetingCapture | null = null;
  const machine: RecorderMachine = createRecorderMachine<SaveSink>({
    setFlag: (on) => call.setRecordingFlag(on),
    pickSink: () =>
      pickSaveSink(
        recordingFileName(call.meeting?.title ?? '', new Date()),
        'video/webm'
      ),
    begin: async (sink) => {
      const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('no supported format');
      const capture = await startCapture(sink, mime, () =>
        machine.interrupted()
      );
      capture0 = capture;
      return {
        stop: async () => {
          capture0 = null;
          await capture.stop();
        },
      };
    },
    onChange: () => redraw?.(),
    onRefused: (reason) => toast.error(say(`refused.${reason}`)),
    onSaved: (name) =>
      name
        ? toast.success(say('saved'), { description: name })
        : toast.success(say('savedDownloads')),
    onSaveFailed: () => toast.error(say('saveFailed')),
    onInterrupted: () => toast.error(say('interrupted')),
    now: () => Date.now(),
  });
  return {
    machine,
    capture: () => capture0,
    sync(next: ActiveCall['call'], nextSay: Say, nextRedraw: () => void) {
      call = next;
      say = nextSay;
      redraw = nextRedraw;
    },
  };
}

/**
 * Records the call to this computer. Lives in the layer, so it survives a
 * page change. Our voice is the engine's own mic track, so a mute reaches
 * the file as silence with no code here.
 */
export function MeetingRecorder({ active }: { active: ActiveCall }) {
  const { call, engine, roomUi } = active;
  const t = useTranslations('MeetingRoom.recording');
  const { user } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const [live] = useState(createLive);
  const { machine } = live;
  const [, setTick] = useState(0);
  useEffect(() => {
    live.sync(call, t, () => setTick((n) => n + 1));
  });
  const { state, startedAt } = machine;

  const holder = call.recording?.userId ?? null;
  const holderName =
    holder && holder !== user?.id ? (nameOf(holder) ?? '') : '';
  useEffect(() => {
    roomUi.setRecorder({
      state,
      startedAt,
      holderName,
      request: () => machine.request(),
      stop: () => void machine.stop(),
    });
  }, [roomUi, machine, state, startedAt, holderName]);

  const userId = user?.id ?? null;
  const flagged = call.recording !== null;
  useEffect(() => {
    if (!flagged) machine.flagIs('nobody');
    else machine.flagIs(holder === userId ? 'us' : 'other');
  }, [machine, flagged, holder, userId, state]);

  const inCall = isInCall(call.phase);
  useEffect(() => {
    if (!inCall) void machine.stop();
  }, [machine, inCall]);
  useEffect(() => () => void machine.stop(), [machine]);
  useEffect(() => {
    const onHide = () => void machine.stop();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [machine]);

  // A reconnect or a device switch brings new tracks: every new snapshot
  // re-reads them.
  useEffect(() => {
    const capture = live.capture();
    if (state !== 'recording' || !capture) return;
    const { remote, recordableVideo, localScreen, participants } = call;
    const { participantId, activeSpeakerId } = call;
    const mic = engine.micTrack;
    const people = participants.map((p) => {
      const self = p.id === participantId;
      return {
        id: p.id,
        name: nameOf(p.user_id) ?? '',
        camera: (self ? recordableVideo : remote[p.id]?.video) ?? null,
        screen: (self ? localScreen : remote[p.id]?.screen) ?? null,
      };
    });
    capture.setBoxes(recordingLayout({ people, activeSpeakerId }));
    capture.setAudio([
      ...(mic ? [mic] : []),
      ...Object.values(remote).flatMap((r) => (r.audio ? [r.audio] : [])),
    ]);
  }, [state, call, engine, nameOf, live]);

  return (
    <ConfirmDialog
      open={state === 'confirming'}
      onOpenChange={(open) => {
        // The dialog closes itself before onConfirm, in the same click.
        if (!open) queueMicrotask(() => machine.cancel());
      }}
      title={t('confirmTitle')}
      description={t('confirmBody')}
      confirmLabel={t('start')}
      onConfirm={() => void machine.confirm()}
    />
  );
}
