'use client';

import { useCallback, useSyncExternalStore } from 'react';

import {
  JOIN_LEAVE_SOUNDS_KEY,
  parseSoundPref,
} from '@/lib/meetings/room-ui/panels';

// One source for the whole tab: the settings dialog writes it, and the
// call layer, mounted the whole time, plays the tones. Its own file so
// that layer does not load the dialog on every page.
let choice: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (choice !== null) return choice;
  try {
    choice = parseSoundPref(localStorage.getItem(JOIN_LEAVE_SOUNDS_KEY));
  } catch {
    choice = false;
  }
  return choice;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The join/leave sound switch, kept in localStorage; off by default. */
export function useJoinLeaveSounds(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    choice = next;
    try {
      localStorage.setItem(JOIN_LEAVE_SOUNDS_KEY, next ? '1' : '0');
    } catch {
      // Private mode or full storage: the choice lasts this visit only.
    }
    listeners.forEach((fn) => fn());
  }, []);
  return [on, set];
}
