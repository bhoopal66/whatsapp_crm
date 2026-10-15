'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

/** A <video> playing one MediaStreamTrack (a camera or a screen). */
export function VideoTrack({
  track,
  mirrored = false,
  fit = 'cover',
  className,
  videoRef,
}: {
  track: MediaStreamTrack;
  /** Our own camera, as a mirror shows it. Never a screen. */
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
  /** Picture-in-picture needs the element. */
  videoRef?: (el: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    videoRef?.(ref.current);
    return () => videoRef?.(null);
  }, [videoRef]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cn(
        'h-full w-full bg-black',
        fit === 'cover' ? 'object-cover' : 'object-contain',
        mirrored && '-scale-x-100',
        className
      )}
    />
  );
}

/**
 * Plays a remote participant's microphone. Hidden. The engine never
 * calls setSinkId: it only stores the chosen output, which every
 * element applies itself (null = the browser default).
 */
export function AudioTrack({
  track,
  sinkId,
}: {
  track: MediaStreamTrack;
  sinkId: string | null;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    // Autoplay is allowed: the person clicked Join on this page.
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  useEffect(() => {
    const el = ref.current as
      (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el || typeof el.setSinkId !== 'function') return;
    el.setSinkId(sinkId ?? '').catch(() => {});
  }, [sinkId]);
  return <audio ref={ref} autoPlay />;
}
