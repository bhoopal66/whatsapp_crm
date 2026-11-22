'use client';

import { createContext, useContext, useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Mic } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useVoicePlays } from '@/hooks/use-voice-plays';
import {
  ownVoiceNoteIds,
  playedSummary,
  showsReceipts,
  type ChannelKind,
  type ChannelMember,
  type ChatMessage,
  type VoicePlay,
} from '@/lib/chat';
import { avatarTint, initialOf } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

export interface VoicePlaysValue {
  plays: Readonly<Record<string, readonly VoicePlay[]>>;
  kind: ChannelKind;
  members: readonly ChannelMember[];
}

const VoicePlaysContext = createContext<VoicePlaysValue | null>(null);

/**
 * Set by the timeline and the thread panel (useVoicePlays); anywhere
 * else (Files panel, search) a voice note shows no played line.
 */
export const VoicePlaysProvider = VoicePlaysContext.Provider;

/**
 * The provider's value for a timeline: plays of the viewer's own voice
 * notes among `messages`, read only where receipts show (showsReceipts),
 * so a deal room or a big channel asks for nothing. Null while the
 * channel or its members are unknown, or where receipts are off.
 */
export function useVoicePlaysValue(
  messages: readonly ChatMessage[],
  kind: ChannelKind | null,
  members: readonly ChannelMember[] | null
): VoicePlaysValue | null {
  const ws = useChatWorkspaceContext();
  const on = !!kind && !!members && showsReceipts(kind, members.length);
  const ids = useMemo(
    () => (on ? ownVoiceNoteIds(messages, ws.userId) : []),
    [on, messages, ws.userId]
  );
  const plays = useVoicePlays(ws, ids);
  return useMemo(
    () => (on && kind && members ? { plays, kind, members } : null),
    [on, plays, kind, members]
  );
}

/**
 * The played line under the viewer's own voice note, WhatsApp-style: a
 * filled mic and "Played" in a 1:1 DM once the other person played it,
 * "Played by N" elsewhere with, on click, who played it (and when) and
 * who hasn't yet. Nothing before the first play, nor where receipts are
 * off (playedSummary).
 */
export function PlayedBy({
  messageId,
  authorId,
}: {
  messageId: string;
  authorId: string | null;
}) {
  const t = useTranslations('Chat.receipts');
  const tc = useTranslations('Chat');
  const format = useFormatter();
  const value = useContext(VoicePlaysContext);
  const { userId, peopleById } = useChatWorkspaceContext();
  const own =
    !!userId && !!authorId && authorId.toLowerCase() === userId.toLowerCase();
  if (!value || !own) return null;
  const { label, played, notYet } = playedSummary({
    plays: value.plays[messageId] ?? [],
    members: value.members,
    authorId,
    kind: value.kind,
  });
  if (label === 'none') return null;

  const line =
    'text-muted-foreground flex items-center gap-1 px-1 text-xs leading-5';
  const mic = <Mic aria-hidden className="text-info size-3 fill-current" />;
  if (label === 'played')
    return (
      <p className={line}>
        {mic}
        {t('played')}
      </p>
    );

  const nameOf = (id: string) =>
    peopleById.get(id.toLowerCase())?.fullName || tc('unknownPerson');
  const face = (id: string) => (
    <span
      aria-hidden
      className={cn(
        'ring-card flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-2',
        avatarTint(id)
      )}
    >
      {initialOf(peopleById.get(id.toLowerCase())?.fullName)}
    </span>
  );
  const when = (at: string) =>
    format.dateTime(new Date(at), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className={line}>
      <Popover>
        <PopoverTrigger className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none">
          {mic}
          {t('playedBy', { count: played.length })}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-64 gap-3">
          <div>
            <PopoverTitle className="text-muted-foreground mb-1 text-xs">
              {t('playedList')}
            </PopoverTitle>
            <ul className="space-y-1">
              {played.map((p) => (
                <li key={p.userId} className="flex items-center gap-2 text-sm">
                  {face(p.userId)}
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(p.userId)}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {when(p.playedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {notYet.length > 0 && (
            <div>
              <PopoverTitle className="text-muted-foreground mb-1 text-xs">
                {t('notPlayedList')}
              </PopoverTitle>
              <ul className="space-y-1">
                {notYet.map((id) => (
                  <li key={id} className="flex items-center gap-2 text-sm">
                    {face(id)}
                    <span className="truncate">{nameOf(id)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
