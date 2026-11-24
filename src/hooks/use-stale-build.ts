'use client';

import { useEffect, useState } from 'react';

import {
  isChunkLoadError,
  serverAnswers,
  takeReload,
} from '@/lib/app-update/stale-build';
import { textOnPage, unsavedInMemory } from '@/lib/app-update/unsaved';

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * For an error screen: true when the screen broke because this tab is
 * older than the live build, so it offers Reload instead of a retry that
 * cannot work. Reloads by itself when nothing would be lost.
 *
 * What the person typed is looked for while rendering: React renders an
 * error screen before it removes the one that broke, so this is the last
 * moment its fields are on the page. And again after, because a composer
 * parks its draft as it goes.
 */
export function useStaleBuild(error: unknown): boolean {
  const stale = isChunkLoadError(error);
  const [losing] = useState(
    () =>
      stale &&
      typeof document !== 'undefined' &&
      (unsavedInMemory() || textOnPage(document))
  );
  useEffect(() => {
    if (!stale || losing || unsavedInMemory()) return;
    // Offline the reload would end on the browser's own error page.
    if (navigator.onLine === false) return;
    let left = false;
    void serverAnswers().then((up) => {
      // What was started while it was asked counts too.
      if (!up || left || unsavedInMemory() || textOnPage(document)) return;
      if (takeReload(sessionStore(), Date.now())) window.location.reload();
    });
    return () => {
      left = true;
    };
  }, [stale, losing]);
  return stale;
}
