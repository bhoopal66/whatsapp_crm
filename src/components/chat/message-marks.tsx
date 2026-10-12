'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { pinsFor, savedIdsIn, setPin, setSaved } from '@/lib/chat';
import {
  applyPinEvents,
  withMark,
  type PinEvent,
} from '@/lib/chat/composer-input';
import { emitSavedChange } from '@/lib/chat/saved';

import { useChatWorkspaceContext } from './chat-context';

export interface MessageMarks {
  pinned: ReadonlySet<string>;
  saved: ReadonlySet<string>;
  /** Null until the channel's pins are read. */
  pinCount: number | null;
  setPinned: (messageId: string, on: boolean) => Promise<void>;
  setSaved: (messageId: string, on: boolean) => Promise<void>;
}

const EMPTY: ReadonlySet<string> = new Set();
const Ctx = createContext<MessageMarks | null>(null);

/**
 * The open channel's pinned and (the viewer's) saved message ids, for
 * the message actions and the header's "Pinned (n)" chip. Pins follow
 * the workspace's realtime pin events; events that arrive while the
 * pins are being read are replayed over the read. Saves are the
 * viewer's own and change only here.
 */
export function MessageMarksProvider({
  channelId,
  children,
}: {
  channelId: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('Chat.actions');
  const { sb, listen, fail } = useChatWorkspaceContext();
  const [pinned, setPinnedIds] = useState<ReadonlySet<string> | null>(null);
  const [saved, setSavedIds] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    let off = false;
    let buffered: PinEvent[] | null = [];
    const unlisten = listen((e) => {
      if (e.kind !== 'pin') return;
      if (buffered) buffered.push(e.event);
      else setPinnedIds((s) => s && applyPinEvents(s, channelId, [e.event]));
    });
    pinsFor(sb, channelId)
      .then((pins) => {
        if (off) return;
        const events = buffered ?? [];
        buffered = null;
        setPinnedIds(
          applyPinEvents(
            new Set(pins.map((p) => p.messageId)),
            channelId,
            events
          )
        );
      })
      .catch(() => {
        buffered = null;
      });
    savedIdsIn(sb, channelId)
      .then((ids) => !off && setSavedIds(new Set(ids)))
      .catch(() => {});
    return () => {
      off = true;
      unlisten();
    };
  }, [sb, channelId, listen]);

  const setPinned = useCallback(
    async (messageId: string, on: boolean) => {
      setPinnedIds((s) => withMark(s ?? EMPTY, messageId, on));
      try {
        await setPin(sb, messageId, on);
        toast.success(t(on ? 'pinned' : 'unpinned'));
      } catch (err) {
        setPinnedIds((s) => withMark(s ?? EMPTY, messageId, !on));
        fail(err);
      }
    },
    [sb, fail, t]
  );
  const setSavedMark = useCallback(
    async (messageId: string, on: boolean) => {
      setSavedIds((s) => withMark(s, messageId, on));
      try {
        await setSaved(sb, messageId, on);
        // saved_messages has no realtime feed: tell the sidebar's Saved
        // count to re-read now rather than on the next navigation.
        emitSavedChange();
        toast.success(t(on ? 'saved' : 'unsaved'));
      } catch (err) {
        setSavedIds((s) => withMark(s, messageId, !on));
        fail(err);
      }
    },
    [sb, fail, t]
  );

  const value = useMemo<MessageMarks>(
    () => ({
      pinned: pinned ?? EMPTY,
      saved,
      pinCount: pinned ? pinned.size : null,
      setPinned,
      setSaved: setSavedMark,
    }),
    [pinned, saved, setPinned, setSavedMark]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMessageMarks(): MessageMarks {
  const marks = useContext(Ctx);
  if (!marks) throw new Error('useMessageMarks outside MessageMarksProvider');
  return marks;
}
