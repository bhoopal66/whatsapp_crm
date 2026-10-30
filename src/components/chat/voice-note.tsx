'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  markVoicePlayed,
  signedFileUrl,
  type ChatAttachment,
} from '@/lib/chat';
import { formatBytes } from '@/lib/chat/view';
import { claimVoicePlay, shouldRemint } from '@/lib/chat/voice';
import { downloadUrlAs } from '@/lib/media/download';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { VoiceNotePlayer } from '@/components/inbox/voice-note-player';

import { useChatWorkspaceContext } from './chat-context';

/** Messages whose played receipt this page has already sent (or tried). */
const reportedPlays = new Set<string>();

/**
 * A team-chat voice note, or any audio file (`file`), on the inbox's
 * player. The `chat-files` bucket is private and its signed URLs live
 * 300 s, so the URL is minted only once the row is near the viewport,
 * which is when the player loads it, and minted again when the element
 * fails on a URL old enough to have expired. A voice note played by
 * someone other than its author sends one played receipt per page
 * session; an audio file sends none.
 */
export function ChatVoiceNote({
  attachment: a,
  messageId,
  authorId,
  file = false,
}: {
  attachment: ChatAttachment;
  messageId: string;
  authorId: string | null;
  /** An ordinary audio file: show its name and size, send no receipt. */
  file?: boolean;
}) {
  const { sb, userId } = useChatWorkspaceContext();
  const { ref, near } = useNearViewport();
  const [signed, setSigned] = useState<{ url: string; at: number } | null>(
    null
  );
  const [unavailable, setUnavailable] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Bumped to ask for a fresh URL; the mint effect keys on it.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!near) return;
    let off = false;
    signedFileUrl(sb, a.storagePath)
      .then((url) => {
        if (off) return;
        setUnavailable(false);
        setSigned({ url, at: Date.now() });
      })
      .catch(() => {
        if (!off) setUnavailable(true);
      });
    return () => {
      off = true;
    };
  }, [near, sb, a.storagePath, generation]);

  const onLoadError = useCallback(() => {
    if (signed && shouldRemint(signed.at, Date.now()))
      setGeneration((g) => g + 1);
  }, [signed]);

  const onPlay = useCallback(() => {
    if (file || !claimVoicePlay(reportedPlays, messageId, userId, authorId))
      return;
    markVoicePlayed(sb, messageId).catch(() => {});
  }, [file, messageId, userId, authorId, sb]);

  const download = () => {
    setDownloading(true);
    signedFileUrl(sb, a.storagePath)
      .then((url) => downloadUrlAs(url, a.name))
      .catch(() => {})
      .finally(() => setDownloading(false));
  };

  return (
    <div ref={ref} className="max-w-full">
      <VoiceNotePlayer
        src={signed?.url ?? null}
        seed={file ? a.id : messageId}
        tone="chat"
        knownDuration={a.durationMs != null ? a.durationMs / 1000 : undefined}
        onPlay={onPlay}
        onLoadError={onLoadError}
        unavailable={unavailable}
        onDownload={download}
        downloading={downloading}
      />
      {file && (
        <p className="text-muted-foreground mt-1 flex max-w-[18rem] gap-1.5 px-1 text-xs">
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className="shrink-0">{formatBytes(a.bytes)}</span>
        </p>
      )}
    </div>
  );
}
