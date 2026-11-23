'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { OPUS_ENCODER_PATH } from '@/lib/inbox/composer-ui';
import {
  TakeRecorder,
  type MicProblem,
  type RecordedTake,
  type RecordingPhase,
  type TakeIntent,
} from '@/lib/media/take-recorder';

type OpusRecorder = import('opus-recorder').default;

async function createOpusRecorder(): Promise<OpusRecorder> {
  // Lazy: the encoder (a 400 KB worker) loads only when someone records.
  const { default: Recorder } = await import('opus-recorder');
  return new Recorder({
    encoderPath: OPUS_ENCODER_PATH,
    numberOfChannels: 1,
    encoderApplication: 2048, // VOIP: tuned for speech
    encoderSampleRate: 48000,
    streamPages: false, // one callback with the whole file on stop
  });
}

export interface VoiceRecorder<M> {
  phase: RecordingPhase;
  /** Whole seconds recorded so far. */
  seconds: number;
  start: (meta: M) => Promise<boolean>;
  finish: (intent: TakeIntent, meta?: Partial<M>) => boolean;
  cancel: () => void;
  leave: () => void;
  /** Stable, for the live meter. */
  getLevelSource: () => OpusRecorder | null;
}

/**
 * A composer's microphone: `lib/media/take-recorder.ts` with the browser
 * recorder, a clock, and the cap (a forgotten recording ends itself, to
 * be listened to: nobody pressed Send). Unmounting frees the mic; a take
 * already sent still reaches `onTake`, and with `keepReview` one that was
 * stopped does too (a caller that can park it).
 */
export function useVoiceRecorder<M>({
  maxSeconds,
  keepReview = false,
  onTake,
  onProblem,
}: {
  maxSeconds: number;
  keepReview?: boolean;
  onTake: (take: RecordedTake<M>) => void;
  onProblem: (problem: MicProblem) => void;
}): VoiceRecorder<M> {
  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<TakeRecorder<M, OpusRecorder> | null>(null);
  const handlers = useRef({ onTake, onProblem });
  useEffect(() => {
    handlers.current = { onTake, onProblem };
  }, [onTake, onProblem]);

  const start = useCallback(async (meta: M) => {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      handlers.current.onProblem('unsupported');
      return false;
    }
    recorderRef.current ??= new TakeRecorder<M, OpusRecorder>({
      create: createOpusRecorder,
      now: () => performance.now(),
      onPhase: setPhase,
      onTake: (take) => handlers.current.onTake(take),
      onProblem: (problem) => handlers.current.onProblem(problem),
    });
    setSeconds(0);
    return recorderRef.current.start(meta);
  }, []);

  const finish = useCallback(
    (intent: TakeIntent, meta?: Partial<M>) =>
      recorderRef.current?.finish(intent, meta) ?? false,
    []
  );
  const cancel = useCallback(() => recorderRef.current?.cancel(), []);
  const leave = useCallback(() => recorderRef.current?.leave(), []);
  const getLevelSource = useCallback(
    () => recorderRef.current?.live ?? null,
    []
  );

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      const s = Math.floor((recorderRef.current?.elapsedMs() ?? 0) / 1000);
      setSeconds(s);
      if (s >= maxSeconds) recorderRef.current?.finish('review');
    }, 250);
    return () => clearInterval(id);
  }, [phase, maxSeconds]);

  useEffect(() => () => recorderRef.current?.dispose(keepReview), [keepReview]);

  return { phase, seconds, start, finish, cancel, leave, getLevelSource };
}
