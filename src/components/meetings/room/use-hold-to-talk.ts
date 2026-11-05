'use client';

import { useEffect } from 'react';

import { createHoldToTalk } from '@/lib/meetings/room-ui/hold-to-talk';
import { talkReleased, talkStarts } from '@/lib/meetings/room-ui/keys';

/** A menu or dialog answers Space itself, even on a non-button item. */
function insideOverlay(target: EventTarget | null): boolean {
  const el = target as Partial<Element> | null;
  return !!el?.closest?.('[role="dialog"],[role="menu"]');
}

/**
 * Hold Space to talk while muted. Both arguments must be stable: the
 * cleanup releases, so a changing one would end a hold mid-sentence.
 */
export function useHoldToTalk(
  toggleMic: () => Promise<void>,
  micOn: () => boolean
) {
  useEffect(() => {
    const talk = createHoldToTalk({ toggleMic, micOn });
    const release = (key: string | null) => {
      if (talkReleased(key, talk.held())) void talk.release();
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === ' ' && talk.held()) {
        e.preventDefault(); // the key's auto-repeat
        return;
      }
      const target = e.target as HTMLElement | null;
      if (insideOverlay(target)) return;
      if (!talkStarts(e, target, { micOn: micOn(), held: false })) return;
      e.preventDefault();
      talk.press();
    };
    const onUp = (e: KeyboardEvent) => release(e.key);
    // The keyup of a key let go elsewhere never reaches this window.
    const onBlur = () => release(null);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release(null);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      // The call outlives the room when the person browses away.
      release(null);
    };
  }, [toggleMic, micOn]);
}
