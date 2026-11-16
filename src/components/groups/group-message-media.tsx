'use client';

import { useTranslations } from 'next-intl';
import { Download, FileText, MapPin } from 'lucide-react';

import { MediaUnavailable } from '@/components/inbox/message-media';
import type { GroupMediaView } from '@/lib/groups/group-media';
import { cn } from '@/lib/utils';

/**
 * A group message's attachment, drawn like the inbox draws one (photo,
 * video, voice / audio, a document card with its name and size, a
 * location): WhatsApp groups and submission groups both use it. The
 * bytes come straight from the gateway's https link (`group-media.ts`).
 */
export function GroupMessageMedia({ view }: { view: GroupMediaView }) {
  const t = useTranslations('Inbox.bubble');
  const { url } = view;

  let content: React.ReactNode;
  switch (view.kind) {
    case 'image':
    case 'sticker':
      content = url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- a gateway link, not a Next image */}
          <img
            src={url}
            alt={view.caption ?? t('photo')}
            loading="lazy"
            className={cn(
              'rounded-md',
              view.kind === 'sticker'
                ? 'size-32 object-contain'
                : 'max-h-64 max-w-60 object-cover'
            )}
          />
        </a>
      ) : (
        <MediaUnavailable label={t('photo')} t={t} />
      );
      break;
    case 'video':
      content = url ? (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-64 max-w-60 rounded-md"
        />
      ) : (
        <MediaUnavailable label={t('video')} t={t} />
      );
      break;
    case 'audio':
      content = url ? (
        <audio src={url} controls preload="none" className="w-60 max-w-full" />
      ) : (
        <MediaUnavailable label={t('audio')} t={t} />
      );
      break;
    case 'document':
      content = url ? (
        <div className="flex items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-wa-quote flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-sm hover:opacity-90"
          >
            <FileText
              className="text-wa-meta h-6 w-6 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate">
                {view.filename ?? t('document')}
              </span>
              {view.sizeLabel && (
                <span className="text-wa-meta block text-[11px]">
                  {view.sizeLabel}
                </span>
              )}
            </span>
          </a>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            download={view.filename ?? true}
            aria-label={t('download')}
            title={t('download')}
            className="bg-wa-quote text-wa-meta hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-full"
          >
            <Download className="size-4" aria-hidden="true" />
          </a>
        </div>
      ) : (
        <MediaUnavailable label={view.filename ?? t('document')} t={t} />
      );
      break;
    case 'location':
      content = view.location ? (
        <a
          href={view.location.mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-wa-quote flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:opacity-90"
        >
          <MapPin className="text-wa-meta size-5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {view.location.label ?? t('location')}
          </span>
        </a>
      ) : null;
      break;
  }

  return (
    <div className="space-y-1">
      {content}
      {view.caption && (
        <p className="break-words whitespace-pre-wrap">{view.caption}</p>
      )}
    </div>
  );
}
