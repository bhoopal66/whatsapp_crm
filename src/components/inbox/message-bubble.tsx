'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Message, MessageReaction } from '@/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Forward,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from './message-media';
import { InteractivePreview } from '@/components/interactive/interactive-preview';
import { ContactCardMessage } from './contact-card-message';
import { useTranslations } from 'next-intl';

interface MessageBubbleProps {
  message: Message;
  /**
   * First bubble of a run from one side: WhatsApp's little tail on the
   * top corner, pointing at the sender's edge of the thread.
   */
  tail?: boolean;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
}

/** WhatsApp's message text: 14.2px on a 19px line. */
const BODY_TEXT =
  'whitespace-pre-wrap break-words text-[14.2px] leading-[19px]';

function StatusIcon({ status }: { status: Message['status'] }) {
  // Grey like the time beside it, until read: blue ticks, as on the phone.
  switch (status) {
    case 'sending':
      return <Clock className="h-3 w-3" />;
    case 'sent':
      return <Check className="h-3.5 w-3.5" />;
    case 'delivered':
      return <CheckCheck className="h-3.5 w-3.5" />;
    case 'read':
      return <CheckCheck className="text-wa-tick-read h-3.5 w-3.5" />;
    case 'failed':
      return <XCircle className="text-destructive h-3.5 w-3.5" />;
    default:
      return null;
  }
}

/**
 * Whether the content ends in a line of text, which the time and ticks
 * can share (WhatsApp tucks them in at the end of the last line). Must
 * agree with where `MessageContent` places its `trailing` slot.
 */
function endsInText(message: Message): boolean {
  switch (message.content_type) {
    case 'text':
      return true;
    case 'image':
    case 'video':
      return !!message.content_text;
    case 'template':
      return !!(message.content_text || message.template_name);
    case 'interactive':
      return !message.interactive_payload;
    case 'audio':
    case 'document':
    case 'location':
    case 'contacts':
      return false;
    default:
      return true;
  }
}

function MessageContent({
  message,
  t,
  onOpenMedia,
  trailing,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  onOpenMedia?: (messageId: string) => void;
  /**
   * Room reserved at the end of the last text line for the time, in
   * every branch `endsInText` says ends in text.
   */
  trailing?: ReactNode;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case 'text':
      return (
        <p className={BODY_TEXT}>
          {message.content_text}
          {trailing}
        </p>
      );

    case 'image':
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t('photo')} t={t} />
          )}
          {message.content_text && (
            <p className={cn('mt-1', BODY_TEXT)}>
              {message.content_text}
              {trailing}
            </p>
          )}
        </div>
      );

    case 'video':
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t('video')} t={t} />
          )}
          {message.content_text && (
            <p className={cn('mt-1', BODY_TEXT)}>
              {message.content_text}
              {trailing}
            </p>
          )}
        </div>
      );

    case 'audio':
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t('audio')} t={t} />
          )}
        </div>
      );

    case 'document':
      if (!message.media_url) {
        return (
          <MediaUnavailable
            label={message.content_text || t('document')}
            t={t}
          />
        );
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case 'template':
      // Fall back to the template's name when we have no stored body
      // (legacy rows sent before issue #483 was fixed) — never a bubble
      // with nothing in it. The chip is neutral so it reads on both the
      // green outbound and the white inbound bubble.
      return (
        <div>
          <span className="bg-wa-quote text-wa-meta mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
            <LayoutTemplate className="h-3 w-3" />
            {t('template')}
          </span>
          {message.content_text ? (
            <p className={cn('mt-1', BODY_TEXT)}>
              {message.content_text}
              {trailing}
            </p>
          ) : (
            message.template_name && (
              <p className={cn('mt-1 italic opacity-80', BODY_TEXT)}>
                {message.template_name}
                {trailing}
              </p>
            )
          )}
        </div>
      );

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-wa-meta h-4 w-4 shrink-0" />
          <span>{message.content_text || t('locationShared')}</span>
        </div>
      );

    case 'contacts':
      // A shared contact card. Rows from before migration 050 carry only
      // the "[contact] Name" text, so fall back to showing that.
      if (message.contact_cards && message.contact_cards.length > 0) {
        return <ContactCardMessage cards={message.contact_cards} />;
      }
      return (
        <div className="flex items-center gap-2 text-sm">
          <UserRound className="text-wa-meta h-4 w-4 shrink-0" />
          <span>{message.content_text || t('contactShared')}</span>
        </div>
      );

    case 'interactive': {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return (
          <InteractivePreview
            payload={message.interactive_payload}
            className="bg-transparent text-inherit shadow-none ring-0"
          />
        );
      }
      if (message.sender_type === 'customer') {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-wa-meta inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
              <CornerDownLeft className="h-3 w-3" />
              {t('buttonReply')}
            </span>
            <p className={BODY_TEXT}>
              {message.content_text || t('interactiveReply')}
              {trailing}
            </p>
          </div>
        );
      }
      return (
        <p className={BODY_TEXT}>
          {message.content_text || t('interactiveReply')}
          {trailing}
        </p>
      );
    }

    default:
      return (
        <p className={BODY_TEXT}>
          {message.content_text || t('unsupported')}
          {trailing}
        </p>
      );
  }
}

/**
 * WhatsApp's bubble tail (its own 8×13 artwork, with the faint shadow
 * layer under it), filled with the bubble's colour via `currentColor`.
 */
function BubbleTail({ side }: { side: 'in' | 'out' }) {
  return (
    <svg
      viewBox="0 0 8 13"
      width="8"
      height="13"
      aria-hidden="true"
      className={cn(
        'absolute top-0',
        side === 'in'
          ? 'text-wa-bubble-in -left-2'
          : 'text-wa-bubble-out -right-2'
      )}
    >
      {side === 'in' ? (
        <>
          <path
            opacity=".13"
            d="M1.533 3.568 8 12.193V1H2.812C1.042 1 .474 2.156 1.533 3.568z"
          />
          <path
            fill="currentColor"
            d="M1.533 2.568 8 11.193V0H2.812C1.042 0 .474 1.156 1.533 2.568z"
          />
        </>
      ) : (
        <>
          <path
            opacity=".13"
            d="M5.188 1H0v11.193l6.467-8.625C7.526 2.156 6.958 1 5.188 1z"
          />
          <path
            fill="currentColor"
            d="M5.188 0H0v11.193l6.467-8.625C7.526 1.156 6.958 0 5.188 0z"
          />
        </>
      )}
    </svg>
  );
}

export function MessageBubble({
  message,
  tail = false,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');
  const inlineMeta = endsInText(message);

  // Time, ticks, and the AI badge on replies the auto-reply bot wrote
  // (always outbound) so agents tell them from their own at a glance.
  const meta = (
    <>
      {message.ai_generated && (
        <span
          className="bg-wa-teal/15 text-wa-teal inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] leading-none font-semibold tracking-wide uppercase"
          title={t('aiBadgeTitle')}
        >
          <Sparkles className="h-2.5 w-2.5" />
          {t('aiBadge')}
        </span>
      )}
      <span>{time}</span>
      {isAgent && <StatusIcon status={message.status} />}
    </>
  );

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'text-wa-text relative max-w-full rounded-lg px-2.5 pt-1.5 pb-2 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]',
          isAgent ? 'bg-wa-bubble-out' : 'bg-wa-bubble-in',
          tail && (isAgent ? 'rounded-tr-none' : 'rounded-tl-none')
        )}
      >
        {tail && <BubbleTail side={isAgent ? 'out' : 'in'} />}
        {message.is_forwarded && (
          <div className="text-wa-meta mb-0.5 flex items-center gap-1 text-[12px] italic">
            <Forward className="h-3 w-3" />
            {t('forwarded')}
          </div>
        )}
        {reply && (
          <ReplyQuote authorLabel={reply.authorLabel} preview={reply.preview} />
        )}
        <MessageContent
          message={message}
          t={t}
          onOpenMedia={onOpenMedia}
          trailing={
            inlineMeta ? (
              // An invisible twin of the time, holding its room at the
              // end of the last line; the visible one is positioned over
              // that room. A long last line pushes the twin, and with it
              // the time, onto a line of its own.
              <span
                aria-hidden="true"
                className="invisible ml-2 inline-flex items-center gap-1 align-bottom text-[11px] leading-[15px] select-none"
              >
                {meta}
              </span>
            ) : undefined
          }
        />
        <div
          className={cn(
            'text-wa-meta flex items-center gap-1 text-[11px] leading-[15px]',
            inlineMeta ? 'absolute right-2 bottom-1' : 'mt-1 justify-end'
          )}
        >
          {meta}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
