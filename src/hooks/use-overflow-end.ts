'use client';

import { useEffect, useState } from 'react';

import { hasOverflowEnd } from '@/lib/inbox/overflow-end';

/**
 * Whether a horizontal scroller hides content past its end edge,
 * re-checked on scroll and whenever it or its content resizes (a chip
 * appearing, a locale's longer labels, the column narrowing). Returns a
 * callback ref, not a ref object: the scroller can mount after the
 * component does (the list renders its header once loaded), and an
 * effect keyed on a ref object would never see it arrive.
 */
export function useOverflowEnd(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!el) return;
    const update = () => setOverflowing(hasOverflowEnd(el));
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    const observeAll = () => {
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    };
    observeAll();
    // Chips arrive after mount (counts load, signals switch on) as new
    // children, which no ResizeObserver on the old ones would notice.
    const mutations = new MutationObserver(() => {
      observeAll();
      update();
    });
    mutations.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [el]);
  return [setEl, overflowing];
}
