'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FileType,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

import { signedFileUrl, type ChatAttachment } from '@/lib/chat';
import { fileKind, opensInTab, type FileKind } from '@/lib/chat/files';
import { formatBytes } from '@/lib/chat/view';
import { shouldRemint } from '@/lib/chat/voice';
import { downloadUrlAs } from '@/lib/media/download';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

const ICONS: Record<FileKind, { icon: LucideIcon; tint: string }> = {
  pdf: { icon: FileText, tint: 'text-destructive' },
  spreadsheet: { icon: FileSpreadsheet, tint: 'text-success' },
  document: { icon: FileType, tint: 'text-info' },
  presentation: { icon: Presentation, tint: 'text-warning' },
  archive: { icon: FileArchive, tint: 'text-muted-foreground' },
  text: { icon: FileText, tint: 'text-muted-foreground' },
  other: { icon: File, tint: 'text-muted-foreground' },
};

/**
 * A signed URL for `path`, minted once the element is near the viewport
 * and minted again (`onError`) when the element fails on a URL old
 * enough to have expired: the voice note's pattern, for thumbnails and
 * videos.
 */
function useNearSignedUrl(path: string) {
  const { sb } = useChatWorkspaceContext();
  const { ref, near } = useNearViewport();
  const [signed, setSigned] = useState<{ url: string; at: number } | null>(
    null
  );
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!near) return;
    let off = false;
    signedFileUrl(sb, path)
      .then((url) => {
        if (off) return;
        setFailed(false);
        setSigned({ url, at: Date.now() });
      })
      .catch(() => !off && setFailed(true));
    return () => {
      off = true;
    };
  }, [near, sb, path, generation]);
  const onError = useCallback(() => {
    if (signed && shouldRemint(signed.at, Date.now()))
      setGeneration((g) => g + 1);
    else setFailed(true);
  }, [signed]);
  return { ref, url: signed?.url ?? null, failed, onError };
}

/** An image thumbnail that opens the viewer. */
export function ChatImageThumb({
  a,
  onOpen,
  className,
}: {
  a: ChatAttachment;
  onOpen: () => void;
  className?: string;
}) {
  const t = useTranslations('Chat.files');
  const { ref, url, failed, onError } = useNearSignedUrl(a.storagePath);
  return (
    <div ref={ref} className={cn('max-w-64', className)}>
      {failed ? (
        <div className="text-muted-foreground flex size-32 items-center justify-center rounded-lg border p-2 text-center text-xs">
          {t('unavailable')}
        </div>
      ) : url ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('openImage', { name: a.name })}
          className="block size-full overflow-hidden rounded-lg border"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
          <img
            src={url}
            alt={a.name}
            onError={onError}
            className="max-h-48 max-w-64 object-cover"
          />
        </button>
      ) : (
        <div className="bg-muted size-32 animate-pulse rounded-lg" />
      )}
    </div>
  );
}

/** A video played inline, with its name and size. */
export function ChatVideo({ a }: { a: ChatAttachment }) {
  const t = useTranslations('Chat.files');
  const { ref, url, failed, onError } = useNearSignedUrl(a.storagePath);
  return (
    <div ref={ref} className="w-full max-w-sm">
      {failed ? (
        <div className="text-muted-foreground flex aspect-video items-center justify-center rounded-lg border text-xs">
          {t('unavailable')}
        </div>
      ) : url ? (
        <video
          src={url}
          controls
          preload="metadata"
          onError={onError}
          className="bg-muted aspect-video max-h-64 w-full rounded-lg border"
        />
      ) : (
        <div className="bg-muted aspect-video w-full animate-pulse rounded-lg" />
      )}
      <p className="text-muted-foreground mt-1 flex gap-1.5 px-1 text-xs">
        <span className="min-w-0 flex-1 truncate">{a.name}</span>
        <span className="shrink-0">{formatBytes(a.bytes)}</span>
      </p>
    </div>
  );
}

/** Opens a PDF or text file in a new tab; downloads anything else. */
export function openOrDownload(
  sb: ReturnType<typeof useChatWorkspaceContext>['sb'],
  a: Pick<ChatAttachment, 'storagePath' | 'name' | 'mime'>
): Promise<void> {
  return signedFileUrl(sb, a.storagePath).then((url) =>
    opensInTab(fileKind(a.mime, a.name))
      ? void window.open(url, '_blank', 'noopener')
      : downloadUrlAs(url, a.name)
  );
}

/** A file chip: its type's icon, name and size. */
export function ChatFileChip({ a }: { a: ChatAttachment }) {
  const t = useTranslations('Chat.files');
  const { sb } = useChatWorkspaceContext();
  const kind = fileKind(a.mime, a.name);
  const { icon: Icon, tint } = ICONS[kind];
  return (
    <button
      type="button"
      onClick={() => void openOrDownload(sb, a).catch(() => {})}
      title={opensInTab(kind) ? t('open') : t('download')}
      className="hover:bg-muted flex max-w-64 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start text-sm"
    >
      <Icon className={cn('size-5 shrink-0', tint)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{a.name}</span>
        <span className="text-muted-foreground block text-xs">
          {t(`kind.${kind}`)} · {formatBytes(a.bytes)}
        </span>
      </span>
    </button>
  );
}
