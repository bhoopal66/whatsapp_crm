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
  voiceDuration,
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

export type VoiceTone = 'in' | 'out' | 'chat';

/**
 * Colours per surface. 'in' / 'out' are the inbox bubbles' WhatsApp
 * palette, exactly as before 'chat' existed; 'chat' is a plain team-chat
 * row with no bubble, so it brings its own bordered `bg-card-2` card and
 * the semantic tokens (light and dark come from the theme).
 */
const TONES: Record<
  VoiceTone,
  {
    root: string;
    button: string;
    broken: string;
    played: string;
    unplayed: string;
    knob: string;
    knobRing: string;
    focus: string;
    rate: string;
    mic: string;
    meta: string;
    metaHover: string;
  }
> = {
  in: {
    root: '',
    button:
      'bg-wa-green text-wa-green-fg hover:bg-wa-green/90 focus-visible:ring-wa-green',
    broken: 'bg-wa-text/10 text-wa-meta cursor-not-allowed shadow-none',
    played: 'bg-wa-teal',
    unplayed: 'bg-wa-text/25',
    knob: 'bg-wa-teal',
    knobRing: 'shadow-[0_0_0_2px_var(--wa-bubble-in)]',
    focus: 'focus-visible:ring-wa-teal/60',
    rate: 'bg-wa-text/10 text-wa-text hover:bg-wa-text/15',
    mic: 'bg-wa-teal/12 text-wa-teal',
    meta: 'text-wa-meta',
    metaHover: 'hover:text-wa-text',
  },
  out: {
    root: '',
    button:
      'bg-wa-text text-wa-bubble-out focus-visible:ring-wa-text hover:opacity-90',
    broken: 'bg-wa-text/10 text-wa-meta cursor-not-allowed shadow-none',
    played: 'bg-wa-text/75',
    unplayed: 'bg-wa-text/25',
    knob: 'bg-wa-text',
    knobRing: 'shadow-[0_0_0_2px_var(--wa-bubble-out)]',
    focus: 'focus-visible:ring-wa-teal/60',
    rate: 'bg-wa-text/10 text-wa-text hover:bg-wa-text/15',
    mic: 'bg-wa-text/10 text-wa-text/70',
    meta: 'text-wa-meta',
    metaHover: 'hover:text-wa-text',
  },
  chat: {
    root: 'bg-card-2 rounded-xl border px-2.5 pt-2 pb-2.5',
    button:
      'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary',
    broken: 'bg-muted text-muted-foreground cursor-not-allowed shadow-none',
    played: 'bg-primary',
    unplayed: 'bg-muted-foreground/30',
    knob: 'bg-primary',
    knobRing: 'shadow-[0_0_0_2px_var(--card-2)]',
    focus: 'focus-visible:ring-ring/60',
    rate: 'bg-foreground/10 text-foreground hover:bg-foreground/15',
    mic: 'bg-primary-soft text-primary',
    meta: 'text-muted-foreground',
    metaHover: 'hover:text-foreground',
  },
};

export function VoiceNotePlayer({
  src,
  seed,
  tone,
  knownDuration,
  onPlay,
  onLoadError,
  unavailable = false,
  onDownload,
  downloading = false,
  className,
}: {
  /** null: not known yet (a URL still to be minted), so nothing loads. */
  src: string | null;
  /** Seeds the stand-in waveform; a message id keeps it stable. */
  seed: string;
  /** An inbox bubble (inbound grey, outbound green) or a team-chat row. */
  tone: VoiceTone;
  /** Seconds, from the sender; shown only until the real length is known. */
  knownDuration?: number;
  /** Playback actually started (the element's `playing`); may repeat. */
  onPlay?: () => void;
  /** The element could not load `src` (an expired signed URL, say). */
  onLoadError?: () => void;
  /** There is no source to be had: show the can't-play state. */
  unavailable?: boolean;
  onDownload?: () => void;
  downloading?: boolean;
  className?: string;
}) {
  const t = useTranslations('Inbox.voice');
  const c = TONES[tone];
  const { ref: nearRef, near } = useNearViewport();
  const { src: audioSrc, decoded } = useVoiceSource(src ?? '', near && !!src);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [rate, setRate] = useState<PlaybackRate>(1);
  // Keyed to the source that failed, so a re-minted URL gets a fresh try.
  const [brokenSrc, setBrokenSrc] = useState<string | null>();
  const broken = unavailable || (brokenSrc !== undefined && brokenSrc === src);
  // Play pressed before the bytes arrived: start as soon as they do.
  const [wantPlay, setWantPlay] = useState(false);
  const dragging = useRef(false);

  const [fallbackPeaks] = useState(() => seededPeaks(seed));
  const peaks = decoded?.peaks ?? fallbackPeaks;
  const duration = voiceDuration(
    decoded?.duration,
    elementDuration,
    knownDuration
  );
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  const startPlayback = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.play().catch((err: unknown) => {
      // AbortError is a pause that beat the play; only a real refusal
      // means this clip can't be played here.
      if (err instanceof DOMException && err.name === 'NotSupportedError') {
        setBrokenSrc(src);
      }
    });
  }, [src]);

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

  return (
    <div
      ref={nearRef}
      className={cn('w-[18rem] max-w-full select-none', c.root, className)}
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
        onPlaying={onPlay}
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
        onError={() => {
          setBrokenSrc(src);
          onLoadError?.();
        }}
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
            broken ? c.broken : c.button
          )}
        >
          {broken ? (
            <AlertCircle className="h-5 w-5" />
          ) : loading ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" />
          ) : playing ? (
            <Pause className="h-[18px] w-[18px] fill-current" />
          ) : (
            <Play className="ms-0.5 h-[18px] w-[18px] fill-current" />
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
            c.focus,
            'relative flex h-9 min-w-0 flex-1 touch-none items-center justify-between gap-[2px] rounded outline-none focus-visible:ring-2',
            duration > 0 && !broken ? 'cursor-pointer' : 'cursor-default',
            broken && 'opacity-40'
          )}
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={cn(
                'w-[3px] max-w-[3px] min-w-[2px] flex-1 rounded-full transition-[height,background-color] duration-300',
                (i + 0.5) / peaks.length <= progress ? c.played : c.unplayed
              )}
              style={{ height: `${Math.round(p * 100)}%` }}
            />
          ))}
          {!broken && (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full',
                c.knobRing,
                c.knob
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
              className={cn(
                c.rate,
                c.focus,
                'h-6 min-w-[2.5rem] rounded-full px-2 text-xs font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2'
              )}
            >
              {formatRate(rate)}
            </button>
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full',
                c.mic
              )}
            >
              <Mic className="h-[18px] w-[18px]" />
            </span>
          )}
        </div>
      </div>

      <div
        className={cn(
          c.meta,
          'mt-0.5 -mb-1 flex h-[15px] items-center gap-1.5 ps-[3.125rem] text-xs leading-[15px] tabular-nums'
        )}
      >
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
            className={cn(
              c.metaHover,
              c.focus,
              '-my-1 flex h-5 w-5 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 disabled:opacity-60'
            )}
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
