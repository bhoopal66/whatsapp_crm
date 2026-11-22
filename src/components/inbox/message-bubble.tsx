'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  Languages,
  Loader2,
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
import { SenderLine, type SenderLabel } from './sender-label';
import {
  ReminderSuggestionChip,
  type ReminderSuggestionChipProps,
} from './reminder-suggestion-chip';
import { useTranslations } from 'next-intl';
import { canTranslateMessage } from '@/lib/translate/detect';
import {
  cachedMessageTranslation,
  translateMessage,
} from '@/lib/translate/client';

interface MessageBubbleProps {
  message: Message;
  /** Who sent it, named at the top of the bubble. Omitted → no line. */
  sender?: SenderLabel | null;
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
  /** A reminder suggestion's chip (migration 197). Omitted → none. */
  reminder?: ReminderSuggestionChipProps;
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
          <span className="bg-wa-quote text-wa-meta mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium">
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
            <span className="text-wa-meta inline-flex items-center gap-1 text-xs font-medium tracking-wide uppercase">
              <CornerDownLeft className="h-3 w-3 rtl:rotate-180" />
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

type TranslationView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; text: string; showing: boolean }
  | { kind: 'error'; notConfigured: boolean };

/**
 * Translate on an Arabic customer message. The state is keyed by the
 * message id and the text translated, so a bubble that is handed another
 * message (or an edited one) starts over, and a result that comes back
 * for a message no longer on screen is dropped.
 */
function useMessageTranslation(message: Message) {
  const enabled = canTranslateMessage(message);
  const source = message.content_text ?? '';
  const key = `${message.id}\u0000${source}`;

  const [stored, setStored] = useState<{
    key: string;
    view: TranslationView;
  } | null>(null);

  // The agent already translated it this session and the bubble
  // remounted (thread reload, virtualised list): open on the English.
  let view: TranslationView;
  if (stored && stored.key === key) {
    view = stored.view;
  } else {
    const cached = enabled
      ? cachedMessageTranslation(message.id, source)
      : null;
    view = cached
      ? { kind: 'done', text: cached, showing: true }
      : { kind: 'idle' };
  }

  const keyRef = useRef(key);
  const aliveRef = useRef(true);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const messageId = message.id;
  const translate = useCallback(() => {
    const forKey = key;
    setStored({ key: forKey, view: { kind: 'loading' } });
    void translateMessage(messageId, source).then((result) => {
      if (!aliveRef.current || keyRef.current !== forKey) return;
      setStored((prev) =>
        prev && prev.key !== forKey
          ? prev
          : {
              key: forKey,
              view: result.ok
                ? { kind: 'done', text: result.text, showing: true }
                : {
                    kind: 'error',
                    notConfigured: result.code === 'ai_not_configured',
                  },
            }
      );
    });
  }, [key, messageId, source]);

  const toggle = useCallback(() => {
    if (view.kind !== 'done') return;
    setStored({ key, view: { ...view, showing: !view.showing } });
  }, [key, view]);

  return { enabled, view, translate, toggle };
}

/** The control's quiet meta style; the buttons add hover and focus. */
// pb-2.5: the next inbound message's hover toolbar sits 12px above its row
// (`-top-3` in message-actions.tsx), invisible but still clickable; without
// the room it covers this line and swallows the click.
const TRANSLATE_LINE =
  'text-wa-meta flex items-center gap-1 px-1 pt-0.5 pb-2.5 text-[11.5px] leading-4';
const TRANSLATE_BUTTON =
  'hover:text-wa-teal focus-visible:text-wa-teal focus-visible:ring-wa-teal/40 inline-flex items-center gap-1 rounded-sm outline-none focus-visible:underline focus-visible:ring-2';

function TranslateControl({
  view,
  onTranslate,
  onToggle,
  t,
}: {
  view: TranslationView;
  onTranslate: () => void;
  onToggle: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  let body: ReactNode;
  switch (view.kind) {
    case 'idle':
      body = (
        <button
          type="button"
          onClick={onTranslate}
          title={t('translateTitle')}
          className={TRANSLATE_BUTTON}
        >
          <Languages className="h-3 w-3" aria-hidden="true" />
          {t('translate')}
        </button>
      );
      break;
    case 'loading':
      body = (
        <button
          type="button"
          disabled
          className="inline-flex cursor-default items-center gap-1"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('translating')}
        </button>
      );
      break;
    case 'done':
      body = (
        <>
          <Languages className="h-3 w-3 shrink-0" aria-hidden="true" />
          {view.showing && <span>{t('translatedFromArabic')}</span>}
          {view.showing && <span aria-hidden="true">·</span>}
          <button type="button" onClick={onToggle} className={TRANSLATE_BUTTON}>
            {view.showing ? t('showOriginal') : t('showTranslation')}
          </button>
        </>
      );
      break;
    case 'error':
      body = view.notConfigured ? (
        <span>{t('translateNotConfigured')}</span>
      ) : (
        <>
          <span>{t('translateFailed')}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onTranslate}
            className={TRANSLATE_BUTTON}
          >
            {t('retry')}
          </button>
        </>
      );
      break;
  }
  return (
    <div className={TRANSLATE_LINE} aria-live="polite">
      {body}
    </div>
  );
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
        // The artwork points left for 'in'; in RTL the bubble sits on
        // the other side (logical start/end), so the drawing mirrors too.
        'absolute top-0 rtl:-scale-x-100',
        side === 'in'
          ? 'text-wa-bubble-in -start-2'
          : 'text-wa-bubble-out -end-2'
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
  sender,
  tail = false,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  reminder,
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');
  const translation = useMessageTranslation(message);
  // The English goes in place of the Arabic, in the same bubble; only
  // content_text changes, so the time overlay below is laid out as before.
  // No dir="auto" on the text: the time's room is reserved at the end of
  // the last line, and an RTL paragraph would move it under the words.
  const shown =
    translation.enabled &&
    translation.view.kind === 'done' &&
    translation.view.showing
      ? { ...message, content_text: translation.view.text }
      : message;

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');
  const inlineMeta = endsInText(message);
  // A voice note has a clock row of its own; the time and ticks sit at
  // its far end, as on WhatsApp, rather than on a line below.
  const metaOverlay = inlineMeta || message.content_type === 'audio';

  // Time, ticks, and the AI badge on replies the auto-reply bot wrote
  // (always outbound) so agents tell them from their own at a glance.
  const meta = (
    <>
      {message.ai_generated && (
        <span
          className="bg-wa-teal/15 text-wa-teal inline-flex items-center gap-0.5 rounded px-1 py-px text-xs leading-none font-semibold tracking-wide uppercase"
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
          tail && (isAgent ? 'rounded-se-none' : 'rounded-ss-none')
        )}
      >
        {tail && <BubbleTail side={isAgent ? 'out' : 'in'} />}
        {sender && <SenderLine sender={sender} />}
        {message.is_forwarded && (
          <div className="text-wa-meta mb-0.5 flex items-center gap-1 text-[12px] italic">
            <Forward className="h-3 w-3 rtl:rotate-180" />
            {t('forwarded')}
          </div>
        )}
        {reply && (
          <ReplyQuote authorLabel={reply.authorLabel} preview={reply.preview} />
        )}
        <MessageContent
          message={shown}
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
                className="invisible ms-2 inline-flex items-center gap-1 align-bottom text-xs leading-[15px] select-none"
              >
                {meta}
              </span>
            ) : undefined
          }
        />
        <div
          className={cn(
            'text-wa-meta flex items-center gap-1 text-xs leading-[15px]',
            metaOverlay ? 'absolute end-2 bottom-1' : 'mt-1 justify-end'
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
      {/* After the reactions: their chip tucks up over the bubble's
          bottom edge, so a line straight under the bubble would sit
          beneath it. */}
      {translation.enabled && (
        <TranslateControl
          view={translation.view}
          onTranslate={translation.translate}
          onToggle={translation.toggle}
          t={t}
        />
      )}
      {/* Last of all, under the translate line too. */}
      {reminder && <ReminderSuggestionChip {...reminder} />}
    </div>
  );
}
