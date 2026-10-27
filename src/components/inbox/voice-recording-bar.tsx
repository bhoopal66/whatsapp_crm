'use client';

import { useEffect, useState } from 'react';
import { Square, Trash2 } from 'lucide-react';
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
 * clock, a scrolling meter of the mic's real level, the limit, and stop
 * (which stages the take for review, as before).
 *
 * The meter hangs an AnalyserNode off the recorder's source node and
 * only reads it; nothing here starts, stops or closes the recording.
 * Without a source (an old recorder, a failed tap) the meter stays flat.
 */
export function VoiceRecordingBar({
  seconds,
  maxSeconds,
  getLevelSource,
  onCancel,
  onStop,
  stopClassName,
}: {
  seconds: number;
  maxSeconds: number;
  /** Stable (useCallback) — the meter re-taps whenever it changes. */
  getLevelSource: () => LevelSource | null;
  onCancel: () => void;
  onStop: () => void;
  stopClassName?: string;
}) {
  const t = useTranslations('Inbox.voice');
  const tc = useTranslations('Inbox.composer');
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
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
  }, [getLevelSource]);

  const padded = [
    ...Array<number>(Math.max(0, METER_BARS - levels.length)).fill(0),
    ...levels,
  ];
  const nearLimit = maxSeconds - seconds <= 30;

  return (
    <div
      role="group"
      aria-label={tc('recording', {
        current: formatClock(seconds),
        max: formatClock(maxSeconds),
      })}
      className="bg-wa-input flex h-[52px] items-center gap-2 rounded-lg pr-1.5 pl-1"
    >
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('discardRecording')}
        title={t('discardRecording')}
        className="text-wa-icon hover:bg-destructive-soft hover:text-destructive focus-visible:ring-destructive/50 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
      >
        <Trash2 className="h-5 w-5" />
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="bg-destructive absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
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

      <span className="text-wa-text-secondary hidden shrink-0 text-xs tabular-nums sm:inline">
        {t('limit', { max: formatClock(maxSeconds) })}
      </span>

      <button
        type="button"
        onClick={onStop}
        aria-label={tc('stopAndAttach')}
        title={tc('stopAndAttach')}
        className={cn(
          'flex items-center justify-center shadow-sm transition-transform active:scale-95',
          stopClassName
        )}
      >
        <Square className="h-3.5 w-3.5 fill-current" />
      </button>
    </div>
  );
}
