'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Square, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  MIN_PEAK,
  formatClock,
  levelFromTimeDomain,
  pushLevel,
} from '@/lib/media/voice-waveform';

/** Bars in the live meter; the newest enters on the right. */
const METER_BARS = 48;
/** How often the meter takes a reading: about a bar per 90 ms. */
const SAMPLE_MS = 90;

/** What the meter taps: opus-recorder's own graph, once it is live. */
export interface LevelSource {
  audioContext?: AudioContext;
  sourceNode?: AudioNode;
}

/**
 * The composer while the mic is live: discard, a pulsing dot and the
 * clock, a scrolling meter of the mic's real level, then "Listen first"
 * and Send, so a voice note is one tap to start and one tap to send. A
 * caller without `onSend` (the saved voice notes) gets a plain Stop.
 * While the mic is still opening (`starting`) it says so: the browser's
 * question or a slow line would otherwise look like nothing happened.
 *
 * The meter hangs an AnalyserNode off the recorder's source node and
 * only reads it; nothing here starts, stops or closes the recording.
 * Without a source (an old recorder, a failed tap) the meter stays flat.
 */
export function VoiceRecordingBar({
  seconds,
  maxSeconds,
  starting = false,
  getLevelSource,
  onCancel,
  onStop,
  onSend,
  buttonClassName,
}: {
  seconds: number;
  maxSeconds: number;
  /** The mic is not open yet. */
  starting?: boolean;
  /** Stable (useCallback) — the meter re-taps whenever it changes. */
  getLevelSource: () => LevelSource | null;
  onCancel: () => void;
  /** Stop, to listen to it (or to keep it) first. */
  onStop: () => void;
  /** Stop and send at once. */
  onSend?: () => void;
  /** The main button: Send, or Stop without `onSend`. */
  buttonClassName?: string;
}) {
  const t = useTranslations('Inbox.voice');
  const tc = useTranslations('Inbox.composer');
  const [levels, setLevels] = useState<number[]>([]);
  const barRef = useRef<HTMLDivElement>(null);

  // The mic button that had the focus is gone: from here Tab reaches the
  // bar's own buttons.
  useEffect(() => {
    barRef.current?.focus();
  }, []);

  useEffect(() => {
    if (starting) return;
    const source = getLevelSource();
    const ctx = source?.audioContext;
    const node = source?.sourceNode;
    if (!ctx || !node) return;

    let analyser: AnalyserNode;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(analyser);
    } catch {
      return;
    }
    const frame = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= SAMPLE_MS) {
        last = now;
        analyser.getByteTimeDomainData(frame);
        const level = levelFromTimeDomain(frame);
        setLevels((h) => pushLevel(h, level, METER_BARS));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        node.disconnect(analyser);
      } catch {
        // Already torn down by the recorder's stop().
      }
    };
  }, [getLevelSource, starting]);

  const padded = [
    ...Array<number>(Math.max(0, METER_BARS - levels.length)).fill(0),
    ...levels,
  ];
  const nearLimit = maxSeconds - seconds <= 30;

  return (
    <div
      ref={barRef}
      tabIndex={-1}
      role="group"
      aria-label={
        starting
          ? t('starting')
          : tc('recording', {
              current: formatClock(seconds),
              max: formatClock(maxSeconds),
            })
      }
      className="bg-wa-input flex h-[52px] items-center gap-2 rounded-lg ps-1 pe-1.5 outline-none"
    >
      <span role="status" className="sr-only">
        {t(starting ? 'starting' : 'recordingLabel')}
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('discardRecording')}
        title={t('discardRecording')}
        className="text-wa-icon hover:bg-destructive-soft hover:text-destructive focus-visible:ring-destructive/50 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
      >
        <Trash2 className="h-5 w-5" aria-hidden />
      </button>

      {starting ? (
        <div className="text-wa-text-secondary flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <span className="truncate" aria-hidden>
            {t('starting')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="bg-destructive absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
              <span className="bg-destructive relative inline-flex h-2.5 w-2.5 rounded-full" />
            </span>
            <span
              className={cn(
                'w-11 text-[15px] font-medium tabular-nums',
                nearLimit ? 'text-destructive' : 'text-wa-text'
              )}
            >
              {formatClock(seconds)}
            </span>
          </div>

          <div
            aria-hidden="true"
            className="flex h-8 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden"
          >
            {padded.map((level, i) => (
              <span
                key={i}
                className={cn(
                  'w-[3px] shrink-0 rounded-full transition-[height] duration-100',
                  level > 0 ? 'bg-wa-teal' : 'bg-wa-text/20'
                )}
                style={{
                  height: `${Math.round(Math.max(MIN_PEAK, level) * 100)}%`,
                }}
              />
            ))}
          </div>

          <span className="text-wa-text-secondary hidden shrink-0 text-xs tabular-nums lg:inline">
            {t('limit', { max: formatClock(maxSeconds) })}
          </span>
        </>
      )}

      {onSend ? (
        <>
          <button
            type="button"
            onClick={onStop}
            disabled={starting}
            aria-label={t('stopAndListen')}
            title={t('stopAndListen')}
            className="text-wa-text hover:bg-wa-icon-hover focus-visible:ring-ring inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-sm transition-colors outline-none focus-visible:ring-2 disabled:opacity-50 sm:px-3"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            <span className="max-sm:hidden">{t('listenFirst')}</span>
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={starting}
            aria-label={t('sendVoice')}
            title={t('sendVoice')}
            className={cn(
              'flex items-center justify-center shadow-sm transition-transform active:scale-95',
              buttonClassName
            )}
          >
            <Send className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onStop}
          disabled={starting}
          aria-label={t('stop')}
          title={t('stop')}
          className={cn(
            'flex items-center justify-center shadow-sm transition-transform active:scale-95',
            buttonClassName
          )}
        >
          <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Above the composer while a voice note is being sent or made ready. */
export function VoiceWorkStrip({ kind }: { kind: 'send' | 'review' }) {
  const t = useTranslations('Inbox.voice');
  return (
    <p
      role="status"
      className="text-wa-text-secondary flex items-center gap-2 px-1 pb-1.5 text-sm"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      {t(kind === 'send' ? 'sending' : 'preparing')}
    </p>
  );
}

/**
 * Above the composer after a voice note could not be uploaded: the
 * recording is kept, so nobody has to say it again.
 */
export function VoiceFailedStrip({
  disabled,
  onRetry,
  onDiscard,
}: {
  disabled?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations('Inbox.voice');
  return (
    <div
      role="alert"
      className="bg-destructive-soft text-destructive mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 basis-56">{t('notUploaded')}</span>
      <span className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="rounded font-semibold hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50"
        >
          {t('tryAgain')}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {t('discardRecording')}
        </button>
      </span>
    </div>
  );
}
