// What the room's view must remember while the person is on another
// page: the room unmounts when they leave it, and the call does not. One
// store per held engine, so a new call starts from the defaults.

import { PANEL_DEFAULT_WIDTH } from '@/lib/meetings/room-ui/panels';
import type { RecorderState } from '@/lib/meetings/recording/plan';
import type { LayoutMode } from '@/lib/meetings/room-ui/stage';

/** The side panels the room opens and toggles. */
export type RoomPanel = 'chat' | 'people' | 'notes';

/** The recorder in the layer, for the menus that drive it. */
export interface RecorderView {
  state: RecorderState;
  startedAt: number | null;
  /** Who the flag names, for "Alex is recording". */
  holderName: string;
  request: () => void;
  stop: () => void;
}

export interface RoomUiState {
  layout: LayoutMode;
  /** Leave our own camera tile out of the stage. */
  hideSelf: boolean;
  pinnedKey: string | null;
  page: number;
  panel: RoomPanel | null;
  panelWidth: number;
  /** The pop-out, once the layer holding the call has mounted. */
  popout: RoomPopout | null;
  /** The newest chat line read, for the Chat button's unread badge. */
  chatSeenAt: string | null;
  recorder: RecorderView | null;
  /** Someone asked for the invite dialog from outside the People panel. */
  inviting: boolean;
}

/** The meeting's pop-out window, offered by the layer that holds it. */
export interface RoomPopout {
  supported: boolean;
  active: boolean;
  /** Must run inside the click: the browser requires the gesture. */
  open: () => void;
  close: () => void;
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
  setRecorder: (recorder: RecorderView | null) => void;
  setPopout: (popout: RoomPopout | null) => void;
  setInviting: (inviting: boolean) => void;
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
    recorder: null,
    popout: null,
    inviting: false,
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
    setPanel: (panel) => {
      set('panel', panel);
      // The dialog lives in the People panel: a request must not outlive
      // it and open by itself the next time the panel does.
      if (panel !== 'people') set('inviting', false);
    },
    setPanelWidth: (width) => set('panelWidth', width),
    setChatSeenAt: (at) => set('chatSeenAt', at),
    setRecorder: (recorder) => set('recorder', recorder),
    setPopout: (popout) => set('popout', popout),
    setInviting: (inviting) => set('inviting', inviting),
  };
}
