'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';

import { signedFileUrl } from '@/lib/chat';
import { lightboxKeyDelta, stepIndex } from '@/lib/chat/files';
import { shouldRemint } from '@/lib/chat/voice';
import { downloadUrlAs } from '@/lib/media/download';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';

import { useChatWorkspaceContext } from './chat-context';

/** One image the viewer can show. */
export interface LightboxImage {
  id: string;
  storagePath: string;
  name: string;
  authorId: string | null;
  createdAt: string;
}

export interface ImageLightboxProps {
  images: readonly LightboxImage[];
  /** The image shown; null keeps the viewer closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}

const NAV =
  'bg-card/90 text-foreground hover:bg-card flex size-10 items-center justify-center rounded-full border shadow disabled:opacity-30';

/**
 * A full-screen viewer over the images of one message, or of the Files
 * panel's list. The bucket is private, so each image's 300 s URL is
 * minted when it is shown, and minted again when it fails on a URL old
 * enough to have expired. The dialog traps focus, restores it on close
 * and closes on Escape; the arrow keys step without wrapping.
 */
export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: ImageLightboxProps) {
  const t = useTranslations('Chat.files');
  const locale = useLocale();
  const { sb, peopleById } = useChatWorkspaceContext();
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : null;
  const [signed, setSigned] = useState<{
    id: string;
    url: string;
    at: number;
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const path = current?.storagePath ?? null;
  const id = current?.id ?? null;
  useEffect(() => {
    if (!path || !id) return;
    let off = false;
    signedFileUrl(sb, path)
      .then((url) => {
        if (off) return;
        setFailed(null);
        setSigned({ id, url, at: Date.now() });
      })
      .catch(() => {
        if (!off) setFailed(id);
      });
    return () => {
      off = true;
    };
  }, [sb, path, id, generation]);

  const step = useCallback(
    (delta: number) => {
      if (index === null) return;
      const next = stepIndex(index, images.length, delta);
      if (next !== null) onIndex(next);
    },
    [index, images.length, onIndex]
  );

  const download = () => {
    if (!current) return;
    signedFileUrl(sb, current.storagePath)
      .then((url) => downloadUrlAs(url, current.name))
      .catch(() => {});
  };

  const url = signed && current && signed.id === current.id ? signed.url : null;
  const person = current?.authorId
    ? peopleById.get(current.authorId.toLowerCase())
    : undefined;
  const when = (() => {
    if (!current) return '';
    const d = new Date(current.createdAt.replace(' ', 'T'));
    return Number.isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(d);
  })();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          aria-label={t('viewer')}
          onKeyDown={(e) => {
            const delta = lightboxKeyDelta(e.key);
            if (delta === 0) return;
            e.preventDefault();
            step(delta);
          }}
          className="fixed inset-0 z-50 flex flex-col outline-none"
        >
          {current && (
            <>
              <div className="bg-card/90 flex items-center gap-3 border-b px-4 py-2">
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="truncate text-sm font-bold">
                    {current.name}
                  </DialogPrimitive.Title>
                  <p className="text-muted-foreground truncate text-xs">
                    {[person?.fullName ?? t('unknownSender'), when]
                      .filter(Boolean)
                      .join(' · ')}
                    {images.length > 1 &&
                      ` · ${t('position', { n: (index ?? 0) + 1, count: images.length })}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={download}
                  aria-label={t('download')}
                  title={t('download')}
                  className="hover:bg-muted flex size-9 items-center justify-center rounded-md"
                >
                  <Download className="size-4" aria-hidden />
                </button>
                <DialogPrimitive.Close
                  aria-label={t('closeViewer')}
                  className="hover:bg-muted flex size-9 items-center justify-center rounded-md"
                >
                  <X className="size-4" aria-hidden />
                </DialogPrimitive.Close>
              </div>
              <div
                className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:px-16"
                onClick={(e) => e.target === e.currentTarget && onClose()}
              >
                {failed === current.id ? (
                  <p className="bg-card rounded-md px-3 py-2 text-sm">
                    {t('unavailable')}
                  </p>
                ) : url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img
                    src={url}
                    alt={current.name}
                    onError={() => {
                      if (signed && shouldRemint(signed.at, Date.now()))
                        setGeneration((g) => g + 1);
                      else setFailed(current.id);
                    }}
                    className="max-h-full max-w-full rounded-md object-contain shadow-lg"
                  />
                ) : (
                  <div className="bg-muted/60 size-48 animate-pulse rounded-md" />
                )}
                {images.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => step(-1)}
                      disabled={
                        stepIndex(index ?? 0, images.length, -1) === null
                      }
                      aria-label={t('previous')}
                      className={`${NAV} absolute top-1/2 start-3 -translate-y-1/2`}
                    >
                      <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => step(1)}
                      disabled={
                        stepIndex(index ?? 0, images.length, 1) === null
                      }
                      aria-label={t('next')}
                      className={`${NAV} absolute top-1/2 end-3 -translate-y-1/2`}
                    >
                      <ChevronRight className="size-5 rtl:rotate-180" aria-hidden />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
