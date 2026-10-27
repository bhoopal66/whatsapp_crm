'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Latches true once the element comes within `rootMargin` of the thread's
 * visible area, and stays true.
 *
 * Every image bubble used to fetch its bytes the moment it rendered — up
 * to 5 MB each, through the tunnel, for a whole thread history the reader
 * mostly never scrolls to. Now a bubble loads when it's about to be seen.
 * The observer is rooted on the thread's scroller (marked
 * `data-inbox-scroll-root`) because a margin on the document root can't
 * reach past that scroller's clipping. Without IntersectionObserver
 * (very old browsers) it loads straight away, as before.
 */
export function useNearViewport<T extends HTMLElement = HTMLDivElement>(
  rootMargin = '600px 0px'
) {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === 'undefined'
  );

  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: el.closest('[data-inbox-scroll-root]'), rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, rootMargin]);

  return { ref, near };
}
