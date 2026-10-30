'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import type { ChatMessage } from '@/lib/chat';

/**
 * The message a composer is about to quote (156's `reply_to_id`). One
 * provider per composer scope: the channel view's main composer and
 * the thread panel's composer each have their own, so a Reply in the
 * thread never quotes into the channel and the other way round, which
 * is also the scope the database allows.
 */
export interface ReplyTargetValue {
  /** The message to quote; null when the next message quotes none. */
  target: ChatMessage | null;
  set: (message: ChatMessage) => void;
  clear: () => void;
  /** False outside a provider, where set does nothing (no Reply action). */
  available: boolean;
}

const NONE: ReplyTargetValue = {
  target: null,
  set: () => {},
  clear: () => {},
  available: false,
};

const ReplyTargetContext = createContext<ReplyTargetValue>(NONE);

/**
 * `scope` names the composer's place (channel id, or channel + thread
 * root): a target set in one scope is dropped when the scope changes,
 * so it never follows the viewer into another channel.
 */
export function ReplyTargetProvider({
  scope,
  children,
}: {
  scope: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<{
    scope: string;
    target: ChatMessage | null;
  }>({ scope, target: null });
  const set = useCallback(
    (message: ChatMessage) => setState({ scope, target: message }),
    [scope]
  );
  const clear = useCallback(() => setState({ scope, target: null }), [scope]);
  const target = state.scope === scope ? state.target : null;
  const value = useMemo(
    () => ({ target, set, clear, available: true }),
    [target, set, clear]
  );
  return (
    <ReplyTargetContext.Provider value={value}>
      {children}
    </ReplyTargetContext.Provider>
  );
}

export function useReplyTarget(): ReplyTargetValue {
  return useContext(ReplyTargetContext);
}
