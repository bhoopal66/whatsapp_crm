'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import {
  consumePopstate,
  notePopstate,
  recordNavigation,
} from '@/lib/navigation/back-target';

// Feeds lib/navigation/back-target with every location this tab shows,
// so an in-page Back link can return to wherever the person came from.
// Headless: renders nothing.

function Tracker() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';

  // Noted at event time: the page the popstate lands on renders before
  // the effect below records it, and BackLink plans during that render.
  useEffect(() => {
    const onPop = () =>
      notePopstate(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!pathname) return;
    const location = search ? `${pathname}?${search}` : pathname;
    recordNavigation(location, { popstate: consumePopstate(location) });
  }, [pathname, search]);

  return null;
}

/**
 * Mounted once in the dashboard shell. `useSearchParams` needs a
 * Suspense boundary or a statically rendered route bails out of
 * prerendering at build time; a null fallback costs nothing here.
 */
export function BackNavTracker() {
  return (
    <Suspense fallback={null}>
      <Tracker />
    </Suspense>
  );
}
