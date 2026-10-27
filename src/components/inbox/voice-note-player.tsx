'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { AlertCircle, Download, Loader2, Mic, Pause, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { loadMediaBlob } from '@/lib/media/blob-cache';
import { useNearViewport } from '@/hooks/use-near-viewport';
import {
  formatClock,
  formatRate,
  nextPlaybackRate,
  peaksFromSamples,
  seededPeaks,
  seekFraction,
  type PlaybackRate,
} from '@/lib/media/voice-waveform';

/**
 * WhatsApp-style voice note: a round play button, the clip's own
 * waveform as the seek bar, the clock under it and a 1× / 1.5× / 2×
 * pill. Replaces the browser's `<audio controls>`, which looked different
 * in every browser and could not seek an Ogg/Opus recording in Chrome.
 *
 * The bytes are loaded once, near the viewport, through `loadMediaBlob`
 * (cached for the inbound proxy) and played from an object URL, so the
 * waveform decode and playback share one download. That also fixes the
 * length: Chrome reports `Infinity` for an Ogg/Opus file without a
 * duration header (every browser-recorded note), and the decoded buffer
 * knows the real one. If the load fails the element falls back to the
 * plain URL and the waveform stays the seeded stand-in.
 */

/** One note plays at a time across the page, as on the phone. */
let playingNow: HTMLAudioElement | null = null;

/** Above this the clip is music, not a voice note: skip the PCM decode. */
const MAX_DECODE_BYTES = 8 * 1024 * 1024;
const MAX_DECODED = 60;

interface Decoded {
  peaks: number[];
  duration: number;
}

/** Decoded waveforms by URL, so reopening a chat doesn't decode again. */
const decodedCache = new Map<string, Decoded | null>();

async function decodeVoice(url: string, blob: Blob): Promise<Decoded | null> {
  if (decodedCache.has(url)) return decodedCache.get(url) ?? null;
  let result: Decoded | null = null;
  try {
    const Ctx =
      typeof OfflineAudioContext === 'undefined' ? null : OfflineAudioContext;
    if (Ctx && blob.size <= MAX_DECODE_BYTES) {
      // An offline context needs no user gesture and owns no device.
      const ctx = new Ctx(1, 1, 44100);
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      result = {
        peaks: peaksFromSamples(buffer.getChannelData(0)),
        duration: buffer.duration,
      };
    }
  } catch {
    result = null;
  }
  decodedCache.set(url, result);
  while (decodedCache.size > MAX_DECODED) {
    const oldest = decodedCache.keys().next().value;
    if (oldest === undefined) break;
    decodedCache.delete(oldest);
  }
  return result;
}

/** A settled load, tagged with the URL it belongs to. */
interface Loaded {
  url: string;
  objectUrl: string | null;
  failed: boolean;
  decoded: Decoded | null;
}

function useVoiceSource(url: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    loadMediaBlob(url)
      .then(async (blob) => {
        if (cancelled) return;
        const decoded = await decodeVoice(url, blob);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ url, objectUrl, failed: false, decoded });
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ url, objectUrl: null, failed: true, decoded: null });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, enabled]);

  const current = loaded?.url === url ? loaded : null;
  return {
    // Fallback to the plain URL lets the element stream what we couldn't fetch.
    src: current ? (current.objectUrl ?? url) : null,
    decoded: current?.decoded ?? null,
  };
}

export function VoiceNotePlayer({
  src,
  seed,
  tone,
  onDownload,
  downloading = false,
  className,
}: {
  src: string;
  /** Seeds the stand-in waveform; a message id keeps it stable. */
  seed: string;
  /** Which bubble it sits on: inbound grey or outbound green. */
  tone: 'in' | 'out';
  onDownload?: () => void;
  downloading?: boolean;
  className?: string;
}) {
  const t = useTranslations('Inbox.voice');
  const { ref: nearRef, near } = useNearViewport();
  const { src: audioSrc, decoded } = useVoiceSource(src, near);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [rate, setRate] = useState<PlaybackRate>(1);
  const [broken, setBroken] = useState(false);
  // Play pressed before the bytes arrived: start as soon as they do.
  const [wantPlay, setWantPlay] = useState(false);
  const dragging = useRef(false);

  const [fallbackPeaks] = useState(() => seededPeaks(seed));
  const peaks = decoded?.peaks ?? fallbackPeaks;
  const duration =
    decoded?.duration ??
    (Number.isFinite(elementDuration) ? elementDuration : 0);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  const startPlayback = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.play().catch((err: unknown) => {
      // AbortError is a pause that beat the play; only a real refusal
      // means this clip can't be played here.
      if (err instanceof DOMException && err.name === 'NotSupportedError') {
        setBroken(true);
      }
    });
  }, []);

  // Play pressed while the bytes were still loading.
  const playIfWanted = () => {
    if (!wantPlay) return;
    setWantPlay(false);
    startPlayback();
  };

  // Smooth knob while playing; `timeupdate` alone ticks four times a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el && !dragging.current) setCurrent(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = rate;
    el.defaultPlaybackRate = rate;
  }, [rate, audioSrc]);

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (el && playingNow === el) {
        el.pause();
        playingNow = null;
      }
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el || broken) return;
    if (!audioSrc) {
      setWantPlay((w) => !w);
      return;
    }
    if (el.paused) startPlayback();
    else el.pause();
  };

  const seekTo = (fraction: number) => {
    const el = audioRef.current;
    if (!el || !(duration > 0)) return;
    const at = fraction * duration;
    el.currentTime = at;
    setCurrent(at);
  };

  const seekFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    seekTo(seekFraction(e.clientX, box.left, box.width));
  };

  const onSeekKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(duration > 0)) return;
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[
      e.key
    ];
    if (step !== undefined) {
      e.preventDefault();
      seekTo(Math.min(1, Math.max(0, (current + step) / duration)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      seekTo(e.key === 'Home' ? 0 : 1);
    }
  };

  const loading = wantPlay && !audioSrc;
  const showRate = playing || rate !== 1;
  const clock = formatClock(playing || current > 0 ? current : duration);

  const played = tone === 'out' ? 'bg-wa-text/75' : 'bg-wa-teal';
  const knob = tone === 'out' ? 'bg-wa-text' : 'bg-wa-teal';

  return (
    <div
      ref={nearRef}
      className={cn('w-[18rem] max-w-full select-none', className)}
    >
      <audio
        ref={audioRef}
        src={audioSrc ?? undefined}
        preload="metadata"
        onPlay={(e) => {
          const el = e.currentTarget;
          if (playingNow && playingNow !== el) playingNow.pause();
          playingNow = el;
          setPlaying(true);
        }}
        onPause={(e) => {
          if (playingNow === e.currentTarget) playingNow = null;
          setPlaying(false);
        }}
        onEnded={(e) => {
          // Back to the start, as on the phone.
          e.currentTarget.currentTime = 0;
          setCurrent(0);
        }}
        onTimeUpdate={(e) => {
          if (!dragging.current) setCurrent(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={(e) => {
          setElementDuration(e.currentTarget.duration);
          playIfWanted();
        }}
        onDurationChange={(e) => setElementDuration(e.currentTarget.duration)}
        onCanPlay={playIfWanted}
        onError={() => setBroken(true)}
      />

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          disabled={broken}
          aria-label={playing ? t('pause') : t('play')}
          title={playing ? t('pause') : t('play')}
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm transition-[transform,background-color] outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent active:scale-95',
            broken
              ? 'bg-wa-text/10 text-wa-meta cursor-not-allowed shadow-none'
              : tone === 'out'
                ? 'bg-wa-text text-wa-bubble-out focus-visible:ring-wa-text hover:opacity-90'
                : 'bg-wa-green text-wa-green-fg hover:bg-wa-green/90 focus-visible:ring-wa-green'
          )}
        >
          {broken ? (
            <AlertCircle className="h-5 w-5" />
          ) : loading ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" />
          ) : playing ? (
            <Pause className="h-[18px] w-[18px] fill-current" />
          ) : (
            <Play className="ml-0.5 h-[18px] w-[18px] fill-current" />
          )}
        </button>

        <div
          role="slider"
          tabIndex={broken ? -1 : 0}
          aria-label={t('seek')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatClock(current)} / ${formatClock(duration)}`}
          aria-disabled={broken || undefined}
          onKeyDown={onSeekKey}
          onPointerDown={(e) => {
            if (broken || !(duration > 0)) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
            seekFromPointer(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromPointer(e);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          className={cn(
            'focus-visible:ring-wa-teal/60 relative flex h-9 min-w-0 flex-1 touch-none items-center justify-between gap-[2px] rounded outline-none focus-visible:ring-2',
            duration > 0 && !broken ? 'cursor-pointer' : 'cursor-default',
            broken && 'opacity-40'
          )}
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={cn(
                'w-[3px] max-w-[3px] min-w-[2px] flex-1 rounded-full transition-[height,background-color] duration-300',
                (i + 0.5) / peaks.length <= progress ? played : 'bg-wa-text/25'
              )}
              style={{ height: `${Math.round(p * 100)}%` }}
            />
          ))}
          {!broken && (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full',
                tone === 'out'
                  ? 'shadow-[0_0_0_2px_var(--wa-bubble-out)]'
                  : 'shadow-[0_0_0_2px_var(--wa-bubble-in)]',
                knob
              )}
              style={{ left: `${progress * 100}%` }}
            />
          )}
        </div>

        <div className="flex w-10 shrink-0 items-center justify-center">
          {showRate ? (
            <button
              type="button"
              onClick={() => setRate((r) => nextPlaybackRate(r))}
              aria-label={t('speed', { rate: formatRate(rate) })}
              title={t('speed', { rate: formatRate(rate) })}
              className="bg-wa-text/10 text-wa-text hover:bg-wa-text/15 focus-visible:ring-wa-teal/60 h-6 min-w-[2.5rem] rounded-full px-2 text-[11px] font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2"
            >
              {formatRate(rate)}
            </button>
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full',
                tone === 'out'
                  ? 'bg-wa-text/10 text-wa-text/70'
                  : 'bg-wa-teal/12 text-wa-teal'
              )}
            >
              <Mic className="h-[18px] w-[18px]" />
            </span>
          )}
        </div>
      </div>

      <div className="text-wa-meta mt-0.5 -mb-1 flex h-[15px] items-center gap-1.5 pl-[3.125rem] text-[11px] leading-[15px] tabular-nums">
        {broken ? (
          <span className="truncate">{t('cannotPlay')}</span>
        ) : (
          <span>{clock}</span>
        )}
        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            aria-label={t('download')}
            title={t('download')}
            className="hover:text-wa-text focus-visible:ring-wa-teal/60 -my-1 flex h-5 w-5 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 disabled:opacity-60"
          >
            {downloading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
