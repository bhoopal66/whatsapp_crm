'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { mergeVoicePlays, voicePlaysFor, type VoicePlay } from '@/lib/chat';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

type Plays = Readonly<Record<string, readonly VoicePlay[]>>;

const NONE: Plays = {};

/**
 * Who has played the given voice notes (156's chat_voice_plays), by
 * message id. Pass only the viewer's own voice notes in view
 * (ownVoiceNoteIds): each id is read once, and new plays arrive through
 * the workspace's single realtime subscription (`listen`, kind
 * 'voicePlay'), kept only for the ids asked for.
 */
export function useVoicePlays(
  ws: Pick<ChatWorkspace, 'sb' | 'listen'>,
  messageIds: readonly string[]
): Plays {
  const { sb, listen } = ws;
  const [plays, setPlays] = useState<Plays>(NONE);
  // A stable key: the timeline hands a new array on every render.
  const key = useMemo(() => [...messageIds].sort().join(','), [messageIds]);
  const wanted = useRef(new Set<string>());
  const fetched = useRef(new Set<string>());

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    wanted.current = new Set(ids);
    const missing = ids.filter((id) => !fetched.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => fetched.current.add(id));
    voicePlaysFor(sb, missing)
      .then((byId) =>
        setPlays((held) => mergeVoicePlays(held, Object.values(byId).flat()))
      )
      // Read again the next time the set changes.
      .catch(() => missing.forEach((id) => fetched.current.delete(id)));
  }, [sb, key]);

  useEffect(
    () =>
      listen((e) => {
        if (e.kind !== 'voicePlay' || !wanted.current.has(e.play.messageId))
          return;
        setPlays((held) => mergeVoicePlays(held, [e.play]));
      }),
    [listen]
  );

  return plays;
}
