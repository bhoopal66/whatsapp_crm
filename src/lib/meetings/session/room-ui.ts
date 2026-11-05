// What the room's view must remember while the person is on another
// page: the room unmounts when they leave it, and the call does not. One
// store per held engine, so a new call starts from the defaults.

import { PANEL_DEFAULT_WIDTH } from '@/lib/meetings/room-ui/panels';
import type { LayoutMode } from '@/lib/meetings/room-ui/stage';

/** The side panels the room opens and toggles. */
export type RoomPanel = 'chat' | 'people';

export interface RoomUiState {
  layout: LayoutMode;
  /** Leave our own camera tile out of the stage. */
  hideSelf: boolean;
  pinnedKey: string | null;
  page: number;
  panel: RoomPanel | null;
  panelWidth: number;
  /** The newest chat line read, for the Chat button's unread badge. */
  chatSeenAt: string | null;
}

export interface RoomUi {
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => RoomUiState;
  setLayout: (layout: LayoutMode) => void;
  setHideSelf: (hide: boolean) => void;
  setPinnedKey: (key: string | null) => void;
  setPage: (page: number) => void;
  setPanel: (panel: RoomPanel | null) => void;
  setPanelWidth: (width: number) => void;
  setChatSeenAt: (at: string | null) => void;
}

export function createRoomUi(): RoomUi {
  let state: RoomUiState = {
    layout: 'auto',
    hideSelf: false,
    pinnedKey: null,
    page: 0,
    panel: null,
    panelWidth: PANEL_DEFAULT_WIDTH,
    chatSeenAt: null,
  };
  const listeners = new Set<() => void>();
  const set = <K extends keyof RoomUiState>(key: K, value: RoomUiState[K]) => {
    if (state[key] === value) return;
    state = { ...state, [key]: value };
    listeners.forEach((fn) => fn());
  };
  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => state,
    setLayout: (layout) => set('layout', layout),
    setHideSelf: (hide) => set('hideSelf', hide),
    setPinnedKey: (key) => set('pinnedKey', key),
    setPage: (page) => set('page', page),
    setPanel: (panel) => set('panel', panel),
    setPanelWidth: (width) => set('panelWidth', width),
    setChatSeenAt: (at) => set('chatSeenAt', at),
  };
}
