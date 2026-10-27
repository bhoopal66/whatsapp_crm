'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import { useTranslations } from 'next-intl';

interface ReplyQuoteProps {
  /** Who sent the quoted message, as its bubble names them (the
   *  thread's sender labels). Caller resolves this — the quote
   *  component doesn't see the parent Message. */
  authorLabel: string;
  /** Compact text preview. Falls back to a placeholder for media types. */
  preview: string;
  /** Present → renders the composer-chip variant with an X button. Absent →
   *  renders the embedded-in-bubble variant. */
  onDismiss?: () => void;
}

export function ReplyQuote({
  authorLabel,
  preview,
  onDismiss,
}: ReplyQuoteProps) {
  const t = useTranslations('Inbox.replyQuote');
  const isChip = !!onDismiss;
  // WhatsApp's quote: a tinted box with a green bar down its left edge.
  // The tint is a translucent shade, so the same box reads inside the
  // green outbound bubble, the white inbound one, and the composer.
  return (
    <div
      className={cn(
        'border-wa-quote-bar flex items-start gap-2 rounded-md border-l-4 py-1 pr-1.5 pl-2',
        isChip ? 'bg-wa-input' : 'bg-wa-quote mb-1'
      )}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="text-wa-teal truncate text-[12.5px] font-medium">
          {authorLabel}
        </div>
        {/* Wrap the preview instead of truncating to a single line.
         *  `truncate` (white-space: nowrap) forced the quote onto one
         *  impossibly-wide line and — because the parent flex chain
         *  lacked `min-w-0` at every step — pushed the entire inbox
         *  layout wider, shoving the contact sidebar off-screen.
         *  `break-words` also wraps long URLs that have no whitespace
         *  to break on. Issue #165. */}
        <div className="text-wa-text-secondary line-clamp-3 text-[13px] leading-[18px] break-words whitespace-pre-wrap">
          {preview}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('cancelReply')}
          className="text-wa-icon hover:bg-wa-icon-hover flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Build the one-line preview text shown inside a reply quote. */
export function buildReplyPreview(
  message: Message,
  t: ReturnType<typeof useTranslations>
): string {
  if (message.content_text) return message.content_text;
  switch (message.content_type) {
    case 'image':
      return t('photo');
    case 'video':
      return t('video');
    case 'audio':
      return t('audio');
    case 'document':
      return t('document');
    case 'location':
      return t('location');
    case 'template':
      return t('template');
    default:
      return t('message');
  }
}
