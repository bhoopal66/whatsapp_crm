'use client';

import { useCallback, useState } from 'react';
import {
  Download,
  FileText,
  ImageOff,
  Loader2,
  Maximize2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import { downloadMediaMessage } from '@/lib/media/download';
import { useMediaBlobUrl } from '@/hooks/use-media-blob-url';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { VoiceNotePlayer } from './voice-note-player';

/**
 * The media renderers behind `<MessageBubble>`'s image / video / audio /
 * document cases. Split out of message-bubble.tsx so that file stays a
 * thin content switch — everything here is about the two affordances
 * issue #373 asked for: open it full-size, and save it.
 *
 * Both are less trivial than they look, because the two flavours of
 * `media_url` behave differently in the browser. See
 * `@/lib/media/blob-cache` for the proxy-vs-bucket split and
 * `@/lib/media/download` for why `<a download>` alone isn't enough.
 */

type Translator = ReturnType<typeof useTranslations>;

/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = 'max-h-64 max-w-60';

export function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: Translator;
}) {
  return (
    <div className="bg-wa-quote text-wa-meta flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <ImageOff className="h-4 w-4 shrink-0" />
      <span>{t('unavailable', { label })}</span>
    </div>
  );
}

/**
 * Kicks off a download and reports failure as a toast. Kept as a hook so
 * each bubble owns its own in-flight state — a slow 16 MB video shouldn't
 * put a spinner on every other attachment in the thread.
 */
function useMediaDownload(message: Message, t: Translator) {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMediaMessage(message);
    } catch {
      toast.error(t('downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }, [downloading, message, t]);

  return { downloading, download };
}

function MediaActionButton({
  icon: Icon,
  label,
  onClick,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      // Own surface rather than inheriting the bubble's, so the same button
      // reads on the muted inbound fill, the primary outbound fill, and on
      // top of an arbitrary photo.
      className="border-border/60 bg-background/85 text-foreground hover:bg-background flex h-7 w-7 items-center justify-center rounded-full border shadow-sm backdrop-blur-sm transition-colors disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function MediaPlaceholder({
  children,
  ref,
}: {
  children: React.ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className="bg-wa-quote flex h-40 w-60 max-w-full items-center justify-center rounded-lg"
    >
      {children}
    </div>
  );
}

export function MediaImageBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  /** Opens the thread's lightbox on this message. Omitted ⇒ not clickable. */
  onOpen?: () => void;
  t: Translator;
}) {
  // Nothing is fetched until the bubble nears the viewport; until then
  // the hook sees no URL and the placeholder holds the space.
  const { ref: nearRef, near } = useNearViewport();
  const { src, status } = useMediaBlobUrl(near ? message.media_url : undefined);
  // The fetch can succeed and the bytes still not be a decodable image.
  const [broken, setBroken] = useState(false);
  const { downloading, download } = useMediaDownload(message, t);

  if (status === 'error' || broken) {
    return (
      <MediaPlaceholder>
        <ImageOff className="text-wa-meta h-8 w-8" />
      </MediaPlaceholder>
    );
  }

  if (status !== 'ready' || !src) {
    return (
      <MediaPlaceholder ref={nearRef}>
        {near && (
          <div className="border-wa-green h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
        )}
      </MediaPlaceholder>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={t('imageAlt')}
      // Belt and braces for public bucket URLs, which skip the blob
      // fetch: the browser still defers and decodes off the main thread.
      loading="lazy"
      decoding="async"
      className={cn(MEDIA_BOX, 'rounded-lg object-contain')}
      onError={() => setBroken(true)}
    />
  );

  return (
    <div className="group/media relative w-fit">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('viewImage')}
          className="focus-visible:ring-ring block cursor-zoom-in rounded-lg ring-offset-2 ring-offset-transparent outline-none focus-visible:ring-2"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Hover-only: on touch there is no hover, but tapping the image opens
          the viewer, which carries a full-size Download button. */}
      <div className="absolute right-2 bottom-2 opacity-0 transition-opacity group-focus-within/media:opacity-100 group-hover/media:opacity-100">
        <MediaActionButton
          icon={Download}
          label={t('download')}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

export function MediaVideoBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  onOpen?: () => void;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="relative w-fit">
      {/* Plain URL, not a blob: the element should stream rather than wait
          for up to 16 MB to land. */}
      <video
        src={message.media_url}
        controls
        preload="metadata"
        className={cn(MEDIA_BOX, 'rounded-lg')}
      />
      {/* Top-right, clear of the native controls — and always visible, since
          expanding is the only way to watch a clip capped at 15rem wide and
          a touch device gets no hover. */}
      <div className="absolute top-2 right-2 flex gap-1">
        {onOpen && (
          <MediaActionButton
            icon={Maximize2}
            label={t('expandVideo')}
            onClick={onOpen}
          />
        )}
        <MediaActionButton
          icon={Download}
          label={t('download')}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

export function MediaAudioBubble({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const outbound =
    message.sender_type === 'agent' || message.sender_type === 'bot';

  return (
    <VoiceNotePlayer
      src={message.media_url ?? ''}
      seed={message.id}
      tone={outbound ? 'out' : 'in'}
      onDownload={download}
      downloading={downloading}
    />
  );
}

export function MediaDocumentBubble({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="flex items-center gap-2">
      <a
        href={message.media_url}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-wa-quote flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-sm hover:opacity-90"
      >
        <FileText className="text-wa-meta h-6 w-6 shrink-0" />
        <span className="truncate">
          {message.content_text || t('document')}
        </span>
      </a>
      <MediaActionButton
        icon={Download}
        label={t('download')}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}
