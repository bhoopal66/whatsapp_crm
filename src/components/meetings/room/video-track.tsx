'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

/** A <video> playing one MediaStreamTrack (a camera or a screen). */
export function VideoTrack({
  track,
  mirrored = false,
  fit = 'cover',
  className,
}: {
  track: MediaStreamTrack;
  /** Our own camera, as a mirror shows it. Never a screen. */
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
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

/** Plays a remote participant's microphone. Hidden. */
export function AudioTrack({ track }: { track: MediaStreamTrack }) {
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
  return <audio ref={ref} autoPlay />;
}
