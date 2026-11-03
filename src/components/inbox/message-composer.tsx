'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  KeyboardEvent,
  type Ref,
  type SetStateAction,
} from 'react';
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  X,
  Trash2,
  Loader2,
  Sparkles,
  Languages,
  Plus,
  MessageSquareDashed,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  COMPOSER_PREFILL_EVENT,
  aiDraftBox,
  EMPTY_COMPOSER_BOX,
  editBox,
  placeDraft,
  putComposerPrefill,
  restoreBox,
  sessionStore,
  takeComposerPrefill,
  type ComposerBox,
} from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';
import {
  consentRefusal,
  type ConsentRefusal,
  type SendOrigin,
} from '@/lib/whatsapp/send-origin';
import { GatedButton } from '@/components/ui/gated-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  reportComposeCheckOutcome,
  requestComposeCheck,
} from '@/lib/insights/compose-check-view';
import {
  clearParkedDrafts,
  composeFlow,
  initialComposeFlow,
  lateUploadLanding,
  parkDraft,
  takeParkedDraft,
  type ComposeFlowEffect,
  type ComposeFlowEvent,
  type ComposeFlowState,
  type ParkedDrafts,
} from '@/lib/insights/compose-check-flow';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import {
  isExpiredStagedMedia,
  STAGED_MEDIA_SUBFOLDER,
} from '@/lib/storage/staged-media';
import { ReplyQuote } from './reply-quote';
import { VoiceNotePlayer } from './voice-note-player';
import { VoiceRecordingBar } from './voice-recording-bar';
import { useTranslations } from 'next-intl';
import { translateDraft } from '@/lib/translate/client';
import {
  canTranslateDraft,
  landTranslation,
  undoAvailable,
  type DraftTranslation,
} from '@/lib/translate/draft';
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from '@/components/interactive/interactive-builder';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import type { InteractiveMessagePayload, QuickReply } from '@/types';
import { QuickReplyPicker } from './quick-reply-picker';
import { ComposeCheckDialog } from './compose-check-dialog';

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = 'image' | 'video' | 'document' | 'audio';

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = 'chat-media';

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<'image' | 'video' | 'document', string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

/**
 * Lets the thread give a failed reply's text back to the agent. The
 * send clears the text box straight away, and a failed send is never
 * saved, so without this the words exist only in the failed bubble.
 */
export interface ComposerDraftHandle {
  /**
   * Fill the text box with `text`, unless the agent has typed something
   * since; `origin` is what the failed send carried (the missed-call
   * draft keeps its consent re-check).
   */
  restore: (text: string, origin?: SendOrigin | null) => void;
  /** Empty the text box if it still holds exactly `text` (a Retry sent it). */
  clearIf: (text: string) => void;
}

interface MessageComposerProps {
  conversationId: string;
  onSend: (text: string, replyToId?: string, origin?: SendOrigin) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (
    payload: InteractiveMessagePayload,
    replyToId?: string
  ) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /** Puts back the reply quote of a draft parked by a chat switch. */
  onRestoreReply?: (reply: ReplyDraft) => void;
  /** The open chat's customer, named in the "wasn't sent" notice. */
  contactName?: string | null;
  textControl?: Ref<ComposerDraftHandle>;
}

/** The send a check holds back until it answers. */
interface HeldSend {
  send: () => void;
}

/**
 * Drafts (typed text, a staged attachment and its caption, the reply
 * quote) parked by a chat switch, by conversation id. Module-level so they
 * survive the composer re-rendering or remounting (leaving the inbox and
 * coming back) for the life of the tab, but never across logins:
 * `parkedFor` is whose they are, and another signed-in user empties it.
 */
const parkedDrafts: ParkedDrafts<ReplyDraft, MediaDraft> = new Map();
let parkedFor: string | null = null;

/** The composer's round toolbar buttons, in WhatsApp's icon grey. */
const TOOL_BUTTON =
  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full p-0 text-wa-icon transition-colors hover:bg-wa-icon-hover hover:text-wa-icon disabled:cursor-not-allowed disabled:opacity-50';

/** The round green send button. */
const SEND_BUTTON =
  'h-10 w-10 shrink-0 rounded-full bg-wa-green p-0 text-wa-green-fg hover:bg-wa-green/90 disabled:opacity-40';

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = '/opus/encoderWorker.min.js';

/**
 * The consent register's answer for the chat's customer, read fresh
 * under the caller's RLS. Null when it could not be read: the prefill
 * still opens, and the send route checks the register again.
 */
async function readConsentRefusal(
  conversationId: string
): Promise<ConsentRefusal | null> {
  try {
    const { data } = await createClient()
      .from('conversations')
      .select('contact:contacts(do_not_contact_at, opted_out_at)')
      .eq('id', conversationId)
      .maybeSingle();
    const contact = (data as { contact?: unknown } | null)?.contact;
    return consentRefusal(
      (Array.isArray(contact) ? contact[0] : contact) as Parameters<
        typeof consentRefusal
      >[0]
    );
  } catch {
    return null;
  }
}

export function MessageComposer({
  conversationId,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
  onRestoreReply,
  contactName,
  textControl,
}: MessageComposerProps) {
  const t = useTranslations('Inbox.composer');
  const tCheck = useTranslations('ComposeCheck');

  // The box's text, and whether it began as the missed-call draft
  // (ComposerBox): a send of that text carries its origin.
  const [box, setBox] = useState<ComposerBox>(EMPTY_COMPOSER_BOX);
  const text = box.text;
  const setText = useCallback((next: SetStateAction<string>) => {
    setBox((b) => editBox(b, typeof next === 'function' ? next(b.text) : next));
  }, []);
  // "Draft WhatsApp" on the customer page leaves a one-shot text for
  // this chat: it opens in the box, editable, and is never sent by
  // itself. The composer outlives a chat switch, so it is taken when the
  // composer mounts for the chat, when it moves to the chat, or when one
  // is left while the chat is open. It joins what the box holds: typed
  // words stay. The consent register is read again first: a draft left
  // for a customer since marked do-not-contact or opted out is dropped
  // with a notice. A failed read places it; the send is re-checked.
  //
  // openChatRef is what every async answer (an AI draft, an upload, a
  // translation, this prefill) checks before it lands, so it moves in a
  // layout effect. When a switch does not come from a click (a deep link,
  // a notification), passive effects run a task later, and an answer for
  // the chat left that landed in that gap still passed the check: an AI
  // reply for A went into B's box, and an upload's replace deleted A's
  // staged file before the switch parked it for A (a dead link).
  const openChatRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    openChatRef.current = conversationId;
    return () => {
      openChatRef.current = null;
    };
  }, [conversationId]);
  useEffect(() => {
    const take = () => {
      const prefill = takeComposerPrefill(sessionStore(), conversationId);
      if (!prefill) return;
      void readConsentRefusal(conversationId).then((refusal) => {
        if (openChatRef.current !== conversationId) {
          // Moved on before the answer: leave it for that chat again.
          putComposerPrefill(sessionStore(), conversationId, prefill);
          return;
        }
        if (refusal) {
          toast.warning(
            t(
              refusal === 'do_not_contact'
                ? 'draftDroppedDoNotContact'
                : 'draftDroppedOptedOut'
            )
          );
          return;
        }
        setBox((b) => placeDraft(b, prefill, 'missed_call_draft'));
      });
    };
    take();
    const onPut = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === conversationId) take();
    };
    window.addEventListener(COMPOSER_PREFILL_EVENT, onPut);
    return () => {
      window.removeEventListener(COMPOSER_PREFILL_EVENT, onPut);
    };
  }, [conversationId, t]);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Translate to Arabic. `translatingFor` is the chat whose draft is being
  // translated, so a chat switch mid-request frees the button in the next
  // chat. `translation` is what Undo puts back; it is offered only while
  // the box holds exactly the Arabic (undoAvailable), and dropped on a
  // chat switch, while rendering like message-thread's reply quote.
  // `textRef` lets the answer see the box as it is now, not as it was.
  const [translatingFor, setTranslatingFor] = useState<string | null>(null);
  const translating = translatingFor === conversationId;
  const showTranslate = translating || canTranslateDraft(text);
  const [translation, setTranslation] = useState<DraftTranslation | null>(null);
  const [translationFor, setTranslationFor] = useState(conversationId);
  if (translationFor !== conversationId) {
    setTranslationFor(conversationId);
    setTranslation(null);
  }
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // "Check before sending" (migration 149). With the mode off (the
  // default) every send goes straight out, exactly as before. With it
  // on, a free-text send or a caption of 12+ characters is checked
  // first; an error, a 429 or no answer within 2.5 s sends anyway
  // (requestComposeCheck fails open), so the check never stops a
  // message. The decisions are lib/insights/compose-check-flow.ts; this
  // runs its effects. A chat switch during a check or with the dialog
  // open sends nothing: the composer outlives the switch, so the text
  // (or the staged attachment of a caption check) is parked for its own
  // chat and put back on return, the box is emptied (the attachment
  // unstaged) and a notice says where the message is waiting.
  const { settings: insightSettings } = useInsightSettings();
  const composeCheckMode = insightSettings.composeCheckMode;

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object. A layout effect, declared before
  // the chat switch, so the switch sees an upload that landed in the
  // same render as the switch and parks it for the chat it was for.
  const draftRef = useRef<MediaDraft | null>(null);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const [flow, setFlow] =
    useState<ComposeFlowState<HeldSend, ReplyDraft, MediaDraft>>(
      initialComposeFlow
    );
  const flowRef = useRef(flow);
  const checkAbortRef = useRef<AbortController | null>(null);
  const captionRef = useRef<HTMLInputElement>(null);
  const checking = flow.phase === 'checking';
  const activeReview =
    flow.phase === 'review' && flow.conversationId === conversationId
      ? flow
      : null;
  const tCheckRef = useRef(tCheck);
  const tRef = useRef(t);
  useEffect(() => {
    tCheckRef.current = tCheck;
    tRef.current = t;
  }, [tCheck, t]);

  const dispatchCheck = useCallback(function dispatch(
    event: ComposeFlowEvent<HeldSend, ReplyDraft, MediaDraft>
  ): ComposeFlowEffect<HeldSend, ReplyDraft, MediaDraft>[] {
    const step = composeFlow(flowRef.current, event);
    flowRef.current = step.state;
    setFlow(step.state);
    for (const effect of step.effects) {
      switch (effect.type) {
        case 'send':
          effect.payload.send();
          break;
        case 'check': {
          const controller = new AbortController();
          checkAbortRef.current = controller;
          void requestComposeCheck({
            conversationId: effect.conversationId,
            text: effect.text,
            signal: controller.signal,
          }).then((decision) => {
            if (checkAbortRef.current === controller)
              checkAbortRef.current = null;
            dispatch({ type: 'answer', token: effect.token, decision });
          });
          break;
        }
        case 'abort':
          checkAbortRef.current?.abort();
          checkAbortRef.current = null;
          break;
        case 'report':
          reportComposeCheckOutcome(effect.eventId, effect.outcome);
          break;
        case 'park': {
          // An attachment parked over another orphans the older object.
          const displaced = parkDraft(
            parkedDrafts,
            effect.conversationId,
            effect.draft
          );
          if (displaced?.path)
            void deleteAccountMedia(CHAT_MEDIA_BUCKET, displaced.path).catch(
              () => {}
            );
          break;
        }
        case 'clearBox':
          setBox(EMPTY_COMPOSER_BOX);
          break;
        case 'clearAttachment':
          // Unstaged, not deleted: the parked draft owns the object now,
          // so the unmount cleanup must not see it either.
          draftRef.current = null;
          setDraft(null);
          break;
        case 'clearReply':
          clearReplyRef.current?.();
          break;
        case 'notifyParked': {
          const attachment = effect.what === 'attachment';
          toast.warning(
            effect.contactName
              ? tCheckRef.current(attachment ? 'parkedAttachment' : 'parked', {
                  name: effect.contactName,
                })
              : tCheckRef.current(
                  attachment ? 'parkedAttachmentNoName' : 'parkedNoName'
                )
          );
          break;
        }
      }
    }
    return step.effects;
  }, []);

  // The box as of the last render, for the switch below. A layout
  // effect declared before it, like draftRef: an AI draft that landed
  // in the render that switched chats is parked for its own chat.
  const boxRef = useRef(box);
  useLayoutEffect(() => {
    boxRef.current = box;
  }, [box]);
  const restoreReplyRef = useRef(onRestoreReply);
  const clearReplyRef = useRef(onClearReply);
  useEffect(() => {
    restoreReplyRef.current = onRestoreReply;
    clearReplyRef.current = onClearReply;
  }, [onRestoreReply, onClearReply]);
  // The chat the composer shows, as of its last switch: idle state does
  // not record which chat a switch leaves.
  const shownRef = useRef<string | null>(null);
  // The reply quote as of the last render of the chat being left. The
  // thread drops it while rendering the next chat, so by the switch the
  // prop is already null; this is updated in a passive effect, which
  // runs after the switch's layout effect, so the switch still reads the
  // left chat's quote. Keep it passive.
  const replyRef = useRef<ReplyDraft | null>(replyTo ?? null);

  // Parked drafts belong to the login that wrote them: another user
  // signed in to this tab finds the stash empty. A layout effect declared
  // before the switch below, so it runs first.
  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  const userId = useAuth().user?.id ?? null;
  useLayoutEffect(() => {
    if (!userId || parkedFor === userId) return;
    // Nothing can restore a parked attachment after the clear, so delete
    // its object first. The delete runs as the newly signed-in user and
    // storage RLS only allows deletes inside that user's own
    // account-<id> folder: another account's leftovers stay, and the
    // staged sweep removes them. The first sign-in on a tab finds
    // an empty stash.
    for (const a of clearParkedDrafts(parkedDrafts)) removeStaged(a.path);
    parkedFor = userId;
  }, [userId, removeStaged]);

  // On a chat switch: park what the composer holds for the chat just
  // left (settling a check or dialog of it), empty the box, unstage the
  // attachment and drop the quote, then put back what is parked for
  // this one. A layout effect: as a passive one it left a frame in which
  // the next chat showed the left chat's text, and a task-long gap in
  // which an answer for the left chat could still land in the box.
  useLayoutEffect(() => {
    const effects = dispatchCheck({
      type: 'switch',
      from: shownRef.current,
      to: conversationId,
      boxText: boxRef.current.text,
      boxOrigin: boxRef.current.origin,
      staged: draftRef.current,
      reply: replyRef.current,
    });
    shownRef.current = conversationId;
    const boxCleared = effects.some((e) => e.type === 'clearBox');
    const unstaged = effects.some((e) => e.type === 'clearAttachment');
    const parked = takeParkedDraft(
      parkedDrafts,
      conversationId,
      boxCleared ? '' : boxRef.current.text,
      !unstaged && draftRef.current !== null
    );
    if (!parked) return;
    if (parked.text.trim())
      setBox((b) =>
        restoreBox(b, parked.text, parked.origin as SendOrigin | null)
      );
    if (parked.attachment) {
      // Parked longer than the server's sweep age (a tab left open for
      // weeks): the object may be gone, and staging it would send a dead
      // link. Taken out of the stash either way; deleted, best effort.
      if (isExpiredStagedMedia(parked.attachment.path)) {
        removeStaged(parked.attachment.path);
        toast.warning(tRef.current('attachmentExpired'));
      } else {
        draftRef.current = parked.attachment;
        setDraft(parked.attachment);
      }
    }
    if (parked.reply) restoreReplyRef.current?.(parked.reply);
  }, [conversationId, dispatchCheck, removeStaged]);
  // Leaving the inbox parks the draft the same way, so coming back to
  // the chat (the stash lives as long as the tab) puts it back. Declared
  // before the unmount cleanup below: a parked attachment is unstaged
  // first, so that cleanup never deletes it.
  useEffect(
    () => () => {
      dispatchCheck({
        type: 'switch',
        from: shownRef.current,
        to: null,
        boxText: boxRef.current.text,
        boxOrigin: boxRef.current.origin,
        staged: draftRef.current,
        reply: replyRef.current,
      });
      shownRef.current = null;
    },
    [dispatchCheck]
  );
  useEffect(() => {
    replyRef.current = replyTo ?? null;
  }, [replyTo]);

  const reviewSendAnyway = useCallback(
    () => dispatchCheck({ type: 'sendAnyway' }),
    [dispatchCheck]
  );
  const reviewEdit = useCallback(
    () => dispatchCheck({ type: 'edit' }),
    [dispatchCheck]
  );

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);

  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan('send-messages');
  const readOnly = !canSend;
  // Whapi has no 24-hour send window (that was a Meta rule), so the
  // only thing that disables the inputs now is a viewer-role user.
  const inputsDisabled = readOnly;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  // Updaters, not reads of `text`: the answer arrives after the render
  // that sent it, and anything typed since must win.
  useImperativeHandle(
    textControl,
    () => ({
      restore: (restored: string, origin?: SendOrigin | null) => {
        setBox((b) => restoreBox(b, restored, origin ?? null));
        requestAnimationFrame(adjustHeight);
      },
      clearIf: (sent: string) => {
        setText((prev) => (prev === sent ? '' : prev));
        requestAnimationFrame(adjustHeight);
      },
    }),
    [adjustHeight, setText]
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const typed = text;
    const replyToId = replyTo?.id;
    const origin = box.origin ?? undefined;
    // A second Enter while a check runs or its dialog is open does
    // nothing (the flow's double-send guard).
    dispatchCheck({
      type: 'submit',
      mode: composeCheckMode,
      conversationId,
      text: trimmed,
      focus: 'text',
      payload: {
        send: () => {
          onSend(trimmed, replyToId, origin);
          // Unchanged when there was no check. After one, a restore
          // that landed meanwhile (a failed send's text) must stay.
          setText((prev) => (prev === typed ? '' : prev));
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
        },
      },
      park: {
        text: typed,
        reply: replyTo ?? null,
        origin: box.origin,
        attachment: null,
      },
      contactName: contactName ?? null,
    });
  }, [
    text,
    box.origin,
    onSend,
    replyTo,
    setText,
    dispatchCheck,
    composeCheckMode,
    conversationId,
    contactName,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight, setText]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send. Whatever is in the box
  // goes along: the reply is then written from it (lib/ai/draft-prompt),
  // and Undo puts the typed text back.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    const requestedChat = conversationId;
    const requested = text;
    const typed = requested.trim();
    setDrafting(true);
    try {
      const res = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: requestedChat,
          ...(typed ? { typed } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      // A reply drafted for one customer, landing after a switch, would
      // sit in the next chat's box one Enter from going out: dropped,
      // like a moved translation.
      if (openChatRef.current !== requestedChat) return;
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(
            "AI isn't set up yet — enable it in AI Agents → Assistant."
          );
        } else {
          toast.error(data.error ?? "Couldn't draft a reply.");
        }
        return;
      }
      const draftText = typeof data.draft === 'string' ? data.draft.trim() : '';
      if (!draftText) {
        toast.error("The assistant didn't return a reply.");
        return;
      }
      // Only over the text it was asked about: anything typed while the
      // draft was being written wins.
      const landing = landTranslation({
        requested,
        requestedChat,
        currentText: textRef.current,
        currentChat: openChatRef.current,
      });
      if (landing === 'moved') return;
      if (landing === 'changed') {
        toast.info(t('draftChanged'));
        return;
      }
      setBox((b) => aiDraftBox(b, requested, draftText));
      setTranslation(
        typed
          ? { original: requested, translated: draftText, kind: 'ai' }
          : null
      );
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error("Couldn't reach the AI assistant.");
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, text, adjustHeight, t]);

  // Translate the draft into Arabic in place. Nothing is sent: the agent
  // reads it, edits it if they like, and sends it as usual. The answer
  // lands only in the chat that asked, and only over the text it
  // translated (landTranslation); the updater re-checks at write time.
  const handleTranslate = useCallback(async () => {
    if (translating) return;
    const requested = text;
    const requestedChat = conversationId;
    setTranslatingFor(requestedChat);
    try {
      const result = await translateDraft(requested, requestedChat);
      if (!result.ok) {
        if (openChatRef.current !== requestedChat) return;
        toast.error(
          result.code === 'ai_not_configured'
            ? t('translateNotConfigured')
            : t('translateFailed')
        );
        return;
      }
      const landing = landTranslation({
        requested,
        requestedChat,
        currentText: textRef.current,
        currentChat: openChatRef.current,
      });
      if (landing === 'moved') return;
      if (landing === 'changed') {
        toast.info(t('translateChanged'));
        return;
      }
      const translated = result.text;
      setText((prev) => (prev === requested ? translated : prev));
      setTranslation({ original: requested, translated });
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } finally {
      setTranslatingFor((c) => (c === requestedChat ? null : c));
    }
  }, [translating, text, conversationId, setText, adjustHeight, t]);

  // Put the English back: only over the untouched Arabic, through
  // setText like typing, so the missed-call origin rule still holds.
  const undoTranslation = useCallback(() => {
    if (!translation) return;
    const { original, translated } = translation;
    setText((prev) => (prev === translated ? original : prev));
    setTranslation(null);
    requestAnimationFrame(() => {
      adjustHeight();
      textareaRef.current?.focus();
    });
  }, [translation, setText, adjustHeight]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    []
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window.prompt(t('quickReplyNamePrompt'))?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch('/api/quick-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          kind: 'interactive',
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('quickReplySaveError'));
        return;
      }
      toast.success(t('quickReplySaved'));
    } catch {
      toast.error(t('quickReplySaveError'));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === 'interactive' && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? '';
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight, setText]
  );

  // An upload finishes after its chat may have been left: staged then,
  // it would go out to the next customer, and its "replace" would delete
  // that chat's attachment. It is parked, silently, for the chat it was
  // picked (or recorded) in, and comes back there. `owner` is whose the
  // stash was when the upload started: if another login took it since,
  // the file is deleted rather than parked in that login's stash.
  const landUpload = useCallback(
    (startedIn: string | null, owner: string | null, staged: MediaDraft) => {
      const landing = lateUploadLanding({
        startedIn,
        openChat: openChatRef.current,
        ownerAtStart: owner,
        ownerNow: parkedFor,
      });
      if (landing === 'discard') {
        removeStaged(staged.path);
        return;
      }
      if (landing === 'park' && startedIn !== null) {
        const displaced = parkDraft(parkedDrafts, startedIn, {
          text: '',
          origin: null,
          reply: null,
          attachment: staged,
        });
        removeStaged(displaced?.path);
        return;
      }
      // Replacing an existing draft? GC the previous object first.
      removeStaged(draftRef.current?.path);
      setDraft(staged);
    },
    [removeStaged]
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024
          )} MB.`
        );
        return;
      }
      const startedIn = openChatRef.current;
      const owner = parkedFor;
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file,
          { subfolder: STAGED_MEDIA_SUBFOLDER }
        );
        landUpload(startedIn, owner, {
          kind,
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: '',
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [landUpload]
  );

  const handlePicked = useCallback(
    (kind: 'image' | 'video' | 'document', file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload]
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (
      bytes: Uint8Array,
      startedIn: string | null,
      owner: string | null
    ) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File(
        [bytes as unknown as BlobPart],
        `voice-${Date.now()}.ogg`,
        {
          type: 'audio/ogg',
        }
      );
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error('Recording is too long (over 16 MB).');
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file,
          { subfolder: STAGED_MEDIA_SUBFOLDER }
        );
        landUpload(startedIn, owner, {
          kind: 'audio',
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: '',
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [landUpload]
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import('opus-recorder');
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      // The voice note is the chat's it was started in, wherever it stops.
      const startedIn = openChatRef.current;
      const owner = parkedFor;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes, startedIn, owner);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error('Microphone access denied or unavailable.');
    }
  }, [inputsDisabled, busy, recording, finalizeRecording]);

  // The live meter taps the recorder's own graph.
  const getLevelSource = useCallback(() => recorderRef.current, []);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  // An attachment left staged longer than the server's sweep age may be
  // deleted already, and Meta would fetch a dead link. It is unstaged,
  // deleted (best effort) and never sent.
  const dropIfExpired = useCallback(
    (staged: MediaDraft) => {
      if (!isExpiredStagedMedia(staged.path)) return false;
      dispatchCheck({ type: 'discardAttachment' });
      removeStaged(staged.path);
      if (draftRef.current === staged) draftRef.current = null;
      setDraft((d) => (d === staged ? null : d));
      toast.warning(t('attachmentExpired'));
      return true;
    },
    [dispatchCheck, removeStaged, t]
  );

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    const staged = draft;
    if (dropIfExpired(staged)) return;
    const replyToId = replyTo?.id;
    // Audio takes no caption (Meta rejects it). Everything else: the
    // trimmed caption, or undefined when blank. A caption is checked
    // like typed text; a bare attachment never is.
    const caption =
      staged.kind === 'audio' ? undefined : staged.caption.trim() || undefined;
    // A switch during the check parks the staged attachment, caption
    // and reply quote with this chat and unstages it, so it can never
    // be sent into the next chat.
    dispatchCheck({
      type: 'submit',
      mode: composeCheckMode,
      conversationId,
      text: caption ?? '',
      focus: 'caption',
      payload: {
        send: () => {
          // Replaced while the check ran: nothing to send.
          if (draftRef.current !== staged) return;
          // A review dialog can stay open for days.
          if (dropIfExpired(staged)) return;
          onSendMedia({
            kind: staged.kind,
            mediaUrl: staged.mediaUrl,
            path: staged.path,
            caption,
            filename: staged.kind === 'document' ? staged.filename : undefined,
            replyToId,
          });
          // The object is now owned by the sent message — clear without GC.
          setDraft(null);
          onClearReply?.();
        },
      },
      park: {
        text: '',
        reply: replyTo ?? null,
        origin: null,
        attachment: staged,
      },
      contactName: contactName ?? null,
    });
  }, [
    draft,
    busy,
    dropIfExpired,
    onSendMedia,
    replyTo,
    onClearReply,
    dispatchCheck,
    composeCheckMode,
    conversationId,
    contactName,
  ]);

  // Discard GCs the staged object — it was uploaded but never sent —
  // and drops a caption check still running for it.
  const discardDraft = useCallback(() => {
    dispatchCheck({ type: 'discardAttachment' });
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged, dispatchCheck]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-wa-divider bg-wa-panel-header shrink-0 border-t px-2 py-2 sm:px-4">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked('image', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked('video', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked('document', e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {/* After Translate to Arabic, or an AI draft written from the
          typed text, until the result is edited or sent. */}
      {!draft && !recording && undoAvailable(translation, text) && (
        <div className="text-wa-text-secondary mb-1.5 flex items-center gap-1.5 px-1 text-xs">
          {translation.kind === 'ai' ? (
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span>
            {translation.kind === 'ai'
              ? t('draftedFromTyped')
              : t('translatedToArabic')}
          </span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={undoTranslation}
            className="text-wa-teal rounded font-medium hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t('undoTranslate')}
          </button>
        </div>
      )}

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          checking={checking}
          captionRef={captionRef}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <VoiceRecordingBar
          seconds={recordSeconds}
          maxSeconds={MAX_RECORDING_SECONDS}
          getLevelSource={getLevelSource}
          onCancel={cancelRecording}
          onStop={stopRecording}
          stopClassName={SEND_BUTTON}
        />
      ) : (
        <div className="flex items-end gap-1">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t('readOnlyTitle')
                  : inputsDisabled
                    ? undefined
                    : t('attachMedia')
              }
              className={TOOL_BUTTON}
            >
              {busy ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Paperclip className="h-5 w-5" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t('photo')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t('video')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => documentInputRef.current?.click()}
              >
                <FileText className="mr-2 h-4 w-4" />
                {t('document')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void startRecording()}>
                <Mic className="mr-2 h-4 w-4" />
                {t('voiceNote')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + menu — interactive messages + quick replies. Gated on the
              24h window like free-form text (interactive requires it). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t('readOnlyTitle')
                  : inputsDisabled
                    ? undefined
                    : t('moreActions')
              }
              className={TOOL_BUTTON}
            >
              <Plus className="h-5 w-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t('interactiveMessage')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t('quickReplies')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t('sendTemplate')}
            className={cn(TOOL_BUTTON, showTranslate && 'max-sm:hidden')}
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-5 w-5" />
          </GatedButton>

          {/* The draft button stays on a phone while there is text: it
              writes the reply from that text. Templates make way for
              Translate instead (a template does not use the typed text),
              so the box keeps its width. */}
          <span className="contents">
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={drafting}
              title={
                readOnly
                  ? undefined
                  : text.trim()
                    ? t('draftFromTyped')
                    : t('draftWithAI')
              }
              className={cn(TOOL_BUTTON, 'hover:text-wa-teal')}
              onClick={handleDraft}
            >
              {drafting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
            </GatedButton>
          </span>

          {/* Translate to Arabic: shown once there is something to
              translate, and kept while a request is in flight so it
              doesn't vanish under the agent's cursor. Never shown on an
              empty box, so it costs the phone layout no width then. */}
          {showTranslate && (
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={translating || checking}
              title={
                readOnly
                  ? undefined
                  : translating
                    ? t('translatingToArabic')
                    : t('translateToArabic')
              }
              aria-label={
                translating ? t('translatingToArabic') : t('translateToArabic')
              }
              aria-busy={translating || undefined}
              className={cn(TOOL_BUTTON, 'hover:text-wa-teal')}
              onClick={handleTranslate}
            >
              {translating ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Languages className="h-5 w-5" />
              )}
            </GatedButton>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly ? t('readOnlyPlaceholder') : t('typeMessagePlaceholder')
            }
            disabled={readOnly}
            readOnly={checking}
            rows={1}
            // Arabic (a translation, or typed) right-aligns and reads
            // right to left; English stays as it was.
            dir="auto"
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t('readOnlyTitle') : undefined}
            className={cn(
              'bg-wa-input text-wa-text placeholder:text-wa-text-secondary min-h-10 flex-1 resize-none rounded-lg border-0 px-3 py-2.5 text-[15px] leading-5 outline-none',
              readOnly && 'cursor-not-allowed opacity-50'
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || checking}
            onClick={handleSend}
            className={SEND_BUTTON}
            aria-busy={checking || undefined}
          >
            {checking ? (
              <Loader2
                className="h-[18px] w-[18px] animate-spin"
                aria-label={tCheck('checking')}
              />
            ) : (
              <Send className="h-[18px] w-[18px]" />
            )}
          </GatedButton>
        </div>
      )}

      <ComposeCheckDialog
        warnings={activeReview?.warnings ?? null}
        onEdit={reviewEdit}
        onSendAnyway={reviewSendAnyway}
        focusOnClose={
          activeReview?.focus === 'caption' ? captionRef : textareaRef
        }
      />

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('interactiveMessage')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t('saveAsQuickReply')}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t('send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  checking,
  captionRef,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  /** The caption is being checked before sending (send shows busy). */
  checking: boolean;
  captionRef: Ref<HTMLInputElement>;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // A voice note is one row, like the recording bar it replaces:
  // discard, the player (to listen back before sending), send.
  if (draft.kind === 'audio') {
    return (
      <div className="bg-wa-input flex h-[64px] items-center gap-2 rounded-lg pr-1.5 pl-1">
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t('removeAttachment')}
          title={t('removeAttachment')}
          className="text-wa-icon hover:bg-destructive-soft hover:text-destructive focus-visible:ring-destructive/50 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
        >
          <Trash2 className="h-5 w-5" />
        </button>
        <VoiceNotePlayer
          src={draft.mediaUrl}
          seed={draft.path ?? draft.filename}
          tone="in"
          className="w-auto min-w-0 flex-1"
        />
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={SEND_BUTTON}
        >
          <Send className="h-[18px] w-[18px]" />
        </GatedButton>
      </div>
    );
  }

  return (
    <div className="bg-wa-input rounded-lg p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === 'video' && (
            <video
              src={draft.mediaUrl}
              controls
              className="max-h-40 rounded-lg"
            />
          )}
          {draft.kind === 'document' && (
            <div className="text-wa-text flex items-center gap-2 text-sm">
              <FileText className="text-wa-icon h-5 w-5 shrink-0" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t('removeAttachment')}
          className="text-wa-icon hover:bg-wa-icon-hover rounded-full p-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        <input
          ref={captionRef}
          value={draft.caption}
          readOnly={checking}
          maxLength={MEDIA_CAPTION_MAX}
          onChange={(e) => onCaptionChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={t('addCaption')}
          className="bg-wa-panel-header text-wa-text placeholder:text-wa-text-secondary flex-1 rounded-lg border-0 px-3 py-2.5 text-[15px] outline-none"
        />
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy || checking}
          onClick={onSend}
          className={SEND_BUTTON}
          aria-busy={checking || undefined}
        >
          {checking ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" />
          ) : (
            <Send className="h-[18px] w-[18px]" />
          )}
        </GatedButton>
      </div>
    </div>
  );
}
