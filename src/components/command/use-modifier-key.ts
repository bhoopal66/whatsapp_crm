'use client';

import { useSyncExternalStore } from 'react';

import { isApplePlatform, modifierKeyName } from '@/lib/command/platform';

const subscribe = () => () => {};
const client = () => modifierKeyName(isApplePlatform(navigator));
// The server cannot know; hydration shows Ctrl, then the client value.
const server = (): 'Cmd' | 'Ctrl' => 'Ctrl';

/** "Cmd" on a Mac, "Ctrl" otherwise. */
export function useModifierKeyName(): 'Cmd' | 'Ctrl' {
  return useSyncExternalStore(subscribe, client, server);
}
