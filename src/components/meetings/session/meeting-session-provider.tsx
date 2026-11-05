'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import type {
  CallSnapshot,
  MeetingCall,
  MeetingCallEngine,
} from '@/hooks/use-meeting-call';
import { createRoomUi, type RoomUi } from '@/lib/meetings/session/room-ui';
import {
  MeetingSession,
  REJOIN_MARKER_KEY,
  type HeldMeeting,
} from '@/lib/meetings/session/session';

// Every dashboard page loads this module, and the tunnel is slow: the
// engine and the layer stay out of it. The room page brings the engine,
// and the layer arrives through dynamic() once something is held.
const ActiveMeetingLayer = dynamic(
  () => import('./active-meeting-layer').then((m) => m.ActiveMeetingLayer),
  { ssr: false }
);

type Session = MeetingSession<MeetingCallEngine>;

interface SessionContext {
  session: Session;
  roomUiFor: (engine: MeetingCallEngine) => RoomUi;
}

const Context = createContext<SessionContext | null>(null);

const nextTick = (fn: () => void) => {
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
};

const noSubscribe = () => () => {};
const noSnapshot = (): CallSnapshot | null => null;

function hasRejoinMarker(): boolean {
  try {
    return sessionStorage.getItem(REJOIN_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const [value] = useState<SessionContext>(() => {
    const stores = new WeakMap<MeetingCallEngine, RoomUi>();
    return {
      session: new MeetingSession<MeetingCallEngine>({ defer: nextTick }),
      roomUiFor: (engine) => {
        let ui = stores.get(engine);
        if (!ui) {
          ui = createRoomUi();
          stores.set(engine, ui);
        }
        return ui;
      },
    };
  });
  const { session } = value;
  const { engine } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );

  const { user, accountRole } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    engine?.setViewer(userId, accountRole);
  }, [engine, userId, accountRole]);

  // Deferred like a room page's release: React's dev double-mount runs
  // this cleanup between a page's two opens, and the call must survive.
  const disposal = useRef<(() => void) | null>(null);
  useEffect(() => {
    disposal.current?.();
    disposal.current = null;
    return () => {
      disposal.current = nextTick(() => session.dispose());
    };
  }, [session]);

  // Once loaded the layer stays: a finished call's toast comes from it,
  // after the engine has gone.
  const [layerWanted, setLayerWanted] = useState(false);
  const marker = useSyncExternalStore(
    noSubscribe,
    hasRejoinMarker,
    () => false
  );
  if ((engine || marker) && !layerWanted) setLayerWanted(true);

  return (
    <Context.Provider value={value}>
      {children}
      {layerWanted && <ActiveMeetingLayer />}
    </Context.Provider>
  );
}

export function useMeetingSession(): SessionContext {
  const value = useContext(Context);
  if (!value) throw new Error('No MeetingSessionProvider above this.');
  return value;
}

export interface ActiveCall {
  call: MeetingCall;
  engine: MeetingCallEngine;
  meetingId: string;
  roomUi: RoomUi;
}

/** The held call, or null. Safe with nothing held, on any page. */
export function useActiveCall(): ActiveCall | null {
  const { session, roomUiFor } = useMeetingSession();
  const { engine } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );
  const snap = useSyncExternalStore(
    engine?.subscribe ?? noSubscribe,
    engine?.getSnapshot ?? noSnapshot,
    engine?.getSnapshot ?? noSnapshot
  );
  return useMemo(
    () =>
      engine && snap
        ? {
            call: engine.toCall(snap),
            engine,
            meetingId: engine.meetingId,
            roomUi: roomUiFor(engine),
          }
        : null,
    [engine, snap, roomUiFor]
  );
}

export type RoomClaim =
  | { kind: 'loading' }
  | { kind: 'ready'; engine: MeetingCallEngine; roomUi: RoomUi }
  | { kind: 'busy'; held: HeldMeeting; takeOver: () => Promise<void> };

/**
 * The room page's hold on its meeting. Derived from the session rather
 * than kept from open()'s answer, and re-opened whenever the held engine
 * changes: a busy screen turns into the lobby the moment the other call
 * ends.
 */
export function useMeetingRoomClaim(
  meetingId: string,
  create: () => MeetingCallEngine
): RoomClaim {
  const { session, roomUiFor } = useMeetingSession();
  const { engine, title } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );
  const heldId = engine?.meetingId ?? null;

  useEffect(() => {
    session.open(meetingId, create);
  }, [session, meetingId, create, heldId]);
  useEffect(() => () => session.release(meetingId), [session, meetingId]);

  if (!engine) return { kind: 'loading' };
  if (heldId === meetingId) {
    return { kind: 'ready', engine, roomUi: roomUiFor(engine) };
  }
  return {
    kind: 'busy',
    held: { meetingId: engine.meetingId, title },
    takeOver: async () => {
      await session.takeOver(meetingId, create);
    },
  };
}
