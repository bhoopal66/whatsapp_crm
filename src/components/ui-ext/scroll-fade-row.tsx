'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  scrollFadeEdges,
  scrollFadeMask,
  type ScrollFadeEdges,
} from '@/lib/scroll-fade';
import { cn } from '@/lib/utils';

/**
 * A sideways-scrolling tab row that fades the edge where more tabs are
 * hidden and keeps the active tab (`[data-active]`) in view, centred so
 * it clears the fade. A row that fits gets no mask, so desktop is
 * unchanged.
 */
export function ScrollFadeRow({
  activeKey,
  className,
  children,
}: {
  /** Changes when the active tab does (deep links, phones). */
  activeKey: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollFadeEdges>({
    start: false,
    end: false,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = scrollFadeEdges(el);
      setEdges((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next
      );
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // The row and its content both resize (viewport, labels, tab set).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[data-active]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [activeKey]);

  const mask = scrollFadeMask(edges);
  return (
    <div
      ref={ref}
      className={cn('overflow-x-auto', className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}
