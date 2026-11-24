'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
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
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
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
  parkIfFree,
  takeParkedDraft,
  type ComposeFlowEffect,
  type ComposeFlowEvent,
  type ComposeFlowState,
  type ParkedDrafts,
} from '@/lib/insights/compose-check-flow';
import { isImeKey } from '@/lib/keyboard/ime';
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
import {
  VoiceFailedStrip,
  VoiceRecordingBar,
  VoiceWorkStrip,
} from './voice-recording-bar';
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
import { ComposerMoreMenu, type ComposerMenuItem } from './composer-more-menu';
import {
  VoiceLibraryPicker,
  useVoiceLibraryMenuItem,
} from './voice-library-picker';
import { SlashQuickReplyList, slashOptionId } from './slash-quick-reply-list';
import {
  applySlashInsert,
  detectSlashToken,
  matchQuickReplies,
  moveHighlight,
  slashKeyAction,
} from '@/lib/inbox/slash-quick-replies';
import {
  MAX_RECORDING_SECONDS,
  micTooSoon,
  PICKER_ACCEPT,
  PILL_BUTTON,
  SEND_BUTTON,
} from '@/lib/inbox/composer-ui';
import { createUnsentTakes } from '@/lib/inbox/unsent-takes';
import type { MicProblem, RecordedTake } from '@/lib/media/take-recorder';
import { ComposeCheckDialog } from './compose-check-dialog';

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = 'image' | 'video' | 'document' | 'audio';

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = 'chat-media';

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

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
  /** Meta's 24-hour window has closed: only templates may be sent. */
  freeTextBlocked?: boolean;
  /** Why, worded for a toast: a dialog covers the thread's banner. */
  freeTextBlockedText?: string | null;
  /** Told when a recording or staged attachment opens or closes, so
   *  the thread can keep Note mode from hiding a live mic. */
  onBusyChange?: (busy: boolean) => void;
}

/** The send a check holds back until it answers. */
interface HeldSend {
  send: () => void;
}

/** What a recording carries from the mic press to its file. */
interface VoiceMeta {
  /** The chat it was started in: the only one it can go to. */
  chatId: string;
  /** `parkedFor` when it was started. */
  owner: string | null;
  contactName: string | null;
  /** Set by Send: that chat's own send, and the quote it answers. */
  send: {
    deliver: (payload: SendMediaPayload) => void;
    replyToId?: string;
  } | null;
}

/** A recording whose upload failed, kept to be tried again. */
interface UnsentTake {
  file: File;
  meta: VoiceMeta;
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

/**
 * Told the chat when an upload is parked for it: the person can be back
 * in it by then, with no switch left to take the parked draft.
 */
const parkedListeners = new Set<(conversationId: string) => void>();

/** Recordings whose upload failed, by chat. */
const unsentTakes = createUnsentTakes<UnsentTake>();

/**
 * Whether somebody else signed in to this tab since: what `owner` sent
 * must not go out under their name. Nobody (a session that could not be
 * read) is not somebody else; the send then fails as any would.
 */
async function anotherLogin(owner: string | null): Promise<boolean> {
  try {
    const { data } = await createClient().auth.getSession();
    const now = data.session?.user.id;
    return !!now && now !== owner;
  } catch {
    return false;
  }
}

/** A failed send's words back as its chat's draft, if there is no newer. */
export function parkUnsentText(
  userId: string | null,
  conversationId: string,
  draft: { text: string; origin: string | null; reply: ReplyDraft | null }
): boolean {
  if (!userId || parkedFor !== userId) return false;
  return parkIfFree(parkedDrafts, conversationId, {
    ...draft,
    attachment: null,
  });
}

/** The "/" list gives up loading after this long. */
const SLASH_LOAD_TIMEOUT_MS = 8000;

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
  freeTextBlocked = false,
  freeTextBlockedText = null,
  onBusyChange,
}: MessageComposerProps) {
  const t = useTranslations('Inbox.composer');
  const tVoice = useTranslations('Inbox.voice');
  const tCheck = useTranslations('ComposeCheck');
  const tMenu = useTranslations('ComposerMenu');

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
    unsentTakes.claim(userId);
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

  // Puts back what is parked for `chatId`: its text into a box holding
  // `boxText`, its attachment unless one is staged, its quote.
  const restoreParked = useCallback(
    (chatId: string, boxText: string, staged: boolean) => {
      const parked = takeParkedDraft(parkedDrafts, chatId, boxText, staged);
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
    },
    [removeStaged]
  );

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
    restoreParked(
      conversationId,
      boxCleared ? '' : boxRef.current.text,
      !unstaged && draftRef.current !== null
    );
  }, [conversationId, dispatchCheck, restoreParked]);
  // An upload parked for this chat after it was opened again.
  useEffect(() => {
    const onParked = (chatId: string) => {
      if (chatId === openChatRef.current)
        restoreParked(chatId, boxRef.current.text, draftRef.current !== null);
    };
    parkedListeners.add(onParked);
    return () => {
      parkedListeners.delete(onParked);
    };
  }, [restoreParked]);
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

  // Voice notes: the recorder itself is further down (useVoiceRecorder).
  // `voiceWork` is the chat whose recording is being sent or made ready;
  // `unsentHere` this chat's recording whose upload failed.
  const [voiceWork, setVoiceWork] = useState<{
    chatId: string;
    kind: 'send' | 'review';
  } | null>(null);
  const unsentHere = useSyncExternalStore(
    unsentTakes.subscribe,
    () => unsentTakes.get(userId, conversationId),
    () => null
  );

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan('send-messages');
  const readOnly = !canSend;
  // A viewer-role user, or a Meta (Cloud API) chat whose 24-hour window
  // has closed (`freeTextBlocked`, decided by the thread): templates
  // stay usable. Whapi and OpenWA have no window.
  const inputsDisabled = readOnly || freeTextBlocked;

  // GC a staged-but-unsent attachment on unmount so it doesn't orphan in
  // the bucket. (The recorder frees the mic by itself.)
  useEffect(() => {
    return () => removeStaged(draftRef.current?.path);
  }, [removeStaged]);

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

  // When something last went out, for the mic's double-tap guard.
  const lastSentAtRef = useRef(0);

  const handleSend = useCallback(() => {
    // Enter reaches here too, not only the (disabled) Send button: with
    // Meta's window closed nothing free-form may go out.
    if (freeTextBlocked) return;
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
          lastSentAtRef.current = Date.now();
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
    freeTextBlocked,
    box.origin,
    onSend,
    replyTo,
    setText,
    dispatchCheck,
    composeCheckMode,
    conversationId,
    contactName,
  ]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      setCaret(e.target.selectionStart);
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

  // Free-form sends whose dialog was open when the window closed: only
  // their menu items are disabled, so they refuse here too.
  const refuseBlocked = useCallback(() => {
    if (!freeTextBlocked) return false;
    if (freeTextBlockedText) toast.error(freeTextBlockedText);
    return true;
  }, [freeTextBlocked, freeTextBlockedText]);

  const sendInteractive = useCallback(() => {
    if (refuseBlocked()) return;
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [
    refuseBlocked,
    interactivePayload,
    onSendInteractive,
    replyTo?.id,
    onClearReply,
  ]);

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

  // ---- "/" quick replies ---------------------------------------------
  // "/" at the start of the box opens the account's quick replies,
  // filtered by what follows the slash (lib/inbox/slash-quick-replies).
  // Everything is derived from the box's text and caret, so a chat
  // switch (which parks and restores the text) needs no extra handling.
  // Escape hides the list until the slash token goes away.
  const [caret, setCaret] = useState<number | null>(null);
  const slashToken = detectSlashToken(text, caret);
  const [slashDismissed, setSlashDismissed] = useState(false);
  if (!slashToken && slashDismissed) setSlashDismissed(false);
  const [slashItems, setSlashItems] = useState<QuickReply[] | null>(null);
  // Nothing could be loaded: the list closes, so Enter sends as usual
  // instead of waiting for ever. The next "/" tries again.
  const [slashFailed, setSlashFailed] = useState(false);
  if (!slashToken && slashFailed) setSlashFailed(false);
  const slashLoading = slashItems === null;
  const slashOpen =
    !!slashToken &&
    !slashDismissed &&
    !(slashFailed && slashLoading) &&
    !inputsDisabled &&
    !checking;
  const slashQuery = slashToken?.query ?? '';
  const slashMatches = useMemo(
    () =>
      slashOpen && slashItems ? matchQuickReplies(slashItems, slashQuery) : [],
    [slashOpen, slashItems, slashQuery]
  );
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashQueryFor, setSlashQueryFor] = useState('');
  if (slashQueryFor !== slashQuery) {
    setSlashQueryFor(slashQuery);
    setSlashHighlight(0);
  }
  const slashListId = useId();

  // Read the list each time it opens, so a reply saved meanwhile shows.
  useEffect(() => {
    if (!slashOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/quick-replies', {
          cache: 'no-store',
          // Enter waits for this list, so a stalled read counts as failed.
          signal: AbortSignal.timeout(SLASH_LOAD_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setSlashItems((data.quick_replies as QuickReply[]) ?? []);
        }
      } catch {
        // A list read earlier stays usable.
        if (!cancelled) setSlashFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slashOpen]);

  // Replace "/query" with the reply. An interactive reply opens the
  // builder pre-filled, as the picker does, and the token is removed.
  const pickSlash = useCallback(
    (qr: QuickReply) => {
      setSlashDismissed(true);
      const interactive = qr.kind === 'interactive' && !!qr.interactive_payload;
      const body = interactive ? '' : (qr.content_text ?? '');
      // The caret goes after the inserted reply, not to body.length:
      // text after the token would otherwise put it mid-sentence.
      const token = detectSlashToken(text, null);
      const applied = token ? applySlashInsert(text, token, body) : null;
      const nextCaret = applied ? applied.caret : body.length;
      if (applied) setText(applied.text);
      if (interactive && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      setCaret(nextCaret);
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight, setText, text]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeKey(e.nativeEvent)) return;
      if (slashOpen) {
        const count = slashMatches.length;
        const action = slashKeyAction(e, { loading: slashLoading, count });
        if (action !== 'pass') {
          e.preventDefault();
          if (action === 'close') setSlashDismissed(true);
          else if (action === 'up' || action === 'down')
            setSlashHighlight((h) =>
              moveHighlight(h, action === 'down' ? 1 : -1, count)
            );
          else if (action === 'pick')
            pickSlash(slashMatches[Math.min(slashHighlight, count - 1)]);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [
      handleSend,
      slashOpen,
      slashLoading,
      slashMatches,
      slashHighlight,
      pickSlash,
    ]
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
        for (const tell of [...parkedListeners]) tell(startedIn);
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

  // ---- Voice note (client-side Ogg/Opus, no server transcode) ---------

  // A finished recording: uploaded, then sent or staged to be listened
  // to. Send is that chat's own send, captured when it was pressed, so
  // it reaches that chat however soon the person moves on.
  const uploadTake = useCallback(
    async ({ file, meta }: UnsentTake) => {
      setBusy(true);
      setVoiceWork({
        chatId: meta.chatId,
        kind: meta.send ? 'send' : 'review',
      });
      const name = meta.contactName ?? tVoice('thisCustomer');
      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file,
          { subfolder: STAGED_MEDIA_SUBFOLDER }
        );
        if (await anotherLogin(meta.owner)) {
          removeStaged(path);
        } else if (meta.send) {
          lastSentAtRef.current = Date.now();
          meta.send.deliver({
            kind: 'audio',
            mediaUrl: publicUrl,
            path,
            replyToId: meta.send.replyToId,
          });
        } else {
          landUpload(meta.chatId, meta.owner, {
            kind: 'audio',
            mediaUrl: publicUrl,
            path,
            filename: file.name,
            caption: '',
          });
          if (openChatRef.current !== meta.chatId && parkedFor === meta.owner)
            toast.info(tVoice('waiting', { name }));
        }
      } catch {
        // Kept for its chat, which says so; elsewhere a notice does. Not
        // for another login, which must not see the customer's name.
        const kept = unsentTakes.put(meta.owner, meta.chatId, { file, meta });
        if (kept && openChatRef.current !== meta.chatId)
          toast.error(tVoice('notSentElsewhere', { name }));
      } finally {
        setBusy(false);
        setVoiceWork((w) => (w?.chatId === meta.chatId ? null : w));
      }
    },
    [landUpload, removeStaged, tVoice]
  );

  const handleTake = useCallback(
    (take: RecordedTake<VoiceMeta>) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File(
        [take.bytes as unknown as BlobPart],
        `voice-${Date.now()}.ogg`,
        { type: 'audio/ogg' }
      );
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        setVoiceWork(null);
        toast.error(tVoice('tooLarge'));
        return;
      }
      void uploadTake({ file, meta: take.meta });
    },
    [uploadTake, tVoice]
  );

  const handleMicProblem = useCallback(
    (problem: MicProblem) => {
      setVoiceWork(null);
      toast.error(tVoice(`problem.${problem}`));
    },
    [tVoice]
  );

  const {
    phase: voicePhase,
    seconds: recordSeconds,
    start: startTake,
    finish: finishTake,
    cancel: cancelRecording,
    leave: leaveTake,
    getLevelSource,
  } = useVoiceRecorder<VoiceMeta>({
    maxSeconds: MAX_RECORDING_SECONDS,
    // Back on a phone takes the composer with it: what was being recorded
    // is parked for its chat like any upload.
    keepReview: true,
    onTake: handleTake,
    onProblem: handleMicProblem,
  });
  const recording = voicePhase === 'starting' || voicePhase === 'recording';

  // The box comes back one line high: give it its text's height again.
  useEffect(() => {
    if (!recording && !draft) adjustHeight();
  }, [recording, draft, adjustHeight]);

  const voiceWorkHere = voiceWork?.chatId === conversationId ? voiceWork : null;
  const composerBusy = recording || !!draft || !!voiceWorkHere || !!unsentHere;
  useEffect(() => {
    onBusyChange?.(composerBusy);
  }, [composerBusy, onBusyChange]);

  const startRecording = useCallback(() => {
    if (readOnly || busy || checking || refuseBlocked()) return;
    if (micTooSoon(lastSentAtRef.current, Date.now())) return;
    // One recording waits per chat, and nothing staged is replaced: what
    // is there goes first.
    if (unsentHere || draftRef.current) {
      toast.info(tVoice(unsentHere ? 'keptFirst' : 'draftFirst'));
      return;
    }
    void startTake({
      chatId: conversationId,
      owner: parkedFor,
      contactName: contactName ?? null,
      send: null,
    });
  }, [
    readOnly,
    busy,
    checking,
    refuseBlocked,
    unsentHere,
    tVoice,
    startTake,
    conversationId,
    contactName,
  ]);

  const listenFirst = useCallback(() => {
    if (finishTake('review'))
      setVoiceWork({ chatId: conversationId, kind: 'review' });
  }, [finishTake, conversationId]);

  const sendRecording = useCallback(() => {
    // Meta's window closed while speaking: refused, and kept to listen to.
    if (refuseBlocked()) {
      listenFirst();
      return;
    }
    const send = { deliver: onSendMedia, replyToId: replyTo?.id };
    if (!finishTake('send', { send })) return;
    lastSentAtRef.current = Date.now();
    setVoiceWork({ chatId: conversationId, kind: 'send' });
    onClearReply?.();
  }, [
    refuseBlocked,
    listenFirst,
    onSendMedia,
    replyTo?.id,
    finishTake,
    conversationId,
    onClearReply,
  ]);

  const retryUnsent = useCallback(() => {
    if (!unsentHere || busy) return;
    const { file, meta } = unsentHere;
    if (meta.send && refuseBlocked()) return;
    unsentTakes.remove(meta.chatId);
    void uploadTake({
      file,
      meta: meta.send
        ? { ...meta, send: { ...meta.send, deliver: onSendMedia } }
        : meta,
    });
  }, [unsentHere, busy, refuseBlocked, uploadTake, onSendMedia]);

  // A recording is its chat's. Left running, its Send would stand under
  // the next chat: leaving the chat ends the take, which waits there.
  useLayoutEffect(() => () => leaveTake(), [conversationId, leaveTake]);

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
    // A parked attachment restored, or a recording finalised, after
    // Meta's window closed: refuse rather than let Meta reject it.
    if (!draft || busy || freeTextBlocked) return;
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
          lastSentAtRef.current = Date.now();
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
    freeTextBlocked,
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

  // Voice-note library: sent through onSendMedia like a recorded note.
  const [voiceLibraryOpen, setVoiceLibraryOpen] = useState(false);
  const voiceLibraryItem = useVoiceLibraryMenuItem(
    () => setVoiceLibraryOpen(true),
    freeTextBlocked
  );

  // ---- More menu items ----------------------------------------------
  // Everything that is not attach, AI draft or mic/send. One entry per
  // action, icon + word; a new action is a new entry here (keep the
  // order: sending, then writing, then anything added later).
  const moreMenuItems: ComposerMenuItem[] = [
    {
      id: 'templates',
      icon: LayoutTemplate,
      label: tMenu('templates'),
      onSelect: onOpenTemplates,
    },
    {
      id: 'quick-replies',
      icon: Zap,
      label: tMenu('quickReplies'),
      onSelect: () => setQuickReplyOpen(true),
      disabled: freeTextBlocked,
    },
    {
      id: 'interactive',
      icon: MessageSquareDashed,
      label: tMenu('interactiveMessage'),
      onSelect: () => openInteractiveBuilder(),
      disabled: freeTextBlocked,
    },
    {
      // Also an icon beside the box on wider screens; on a phone this
      // is the only way to it. Shown once there is text to translate.
      id: 'translate',
      icon: Languages,
      label: translating
        ? t('translatingToArabic')
        : tMenu('translateToArabic'),
      onSelect: () => void handleTranslate(),
      disabled: translating || checking || freeTextBlocked,
      busy: translating,
      hidden: !showTranslate,
    },
    {
      // The mic button is Send while the box holds text: this always
      // records. Beside the saved ones, so the two are told apart.
      id: 'record-voice',
      icon: Mic,
      label: tVoice('record'),
      onSelect: startRecording,
      disabled: freeTextBlocked || busy || checking || voicePhase !== 'idle',
    },
    voiceLibraryItem,
    // ---- Add new More menu items above this line ----
  ];

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-wa-divider bg-wa-panel-header relative shrink-0 border-t px-2 py-2 sm:px-4">
      {/* "/" quick replies, above the composer. */}
      {slashOpen && slashToken && !draft && !recording && (
        <SlashQuickReplyList
          id={slashListId}
          query={slashToken.query}
          items={slashMatches}
          loading={slashLoading}
          highlight={slashHighlight}
          onPick={pickSlash}
          onHighlight={setSlashHighlight}
          className="absolute inset-x-2 bottom-full mb-1 sm:inset-x-4"
        />
      )}
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

      {unsentHere && (
        <VoiceFailedStrip
          // Listened to first, it would replace what is staged now.
          disabled={
            busy || voicePhase !== 'idle' || (!!draft && !unsentHere.meta.send)
          }
          onRetry={retryUnsent}
          onDiscard={() => unsentTakes.remove(conversationId)}
        />
      )}
      {voiceWorkHere && <VoiceWorkStrip kind={voiceWorkHere.kind} />}

      {recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <VoiceRecordingBar
          seconds={recordSeconds}
          maxSeconds={MAX_RECORDING_SECONDS}
          starting={voicePhase === 'starting'}
          getLevelSource={getLevelSource}
          onCancel={cancelRecording}
          onStop={listenFirst}
          onSend={sendRecording}
          buttonClassName={SEND_BUTTON}
        />
      ) : draft ? (
        <div className="flex items-end gap-1">
          {/* The same menu, with the one entry that leaves what is
              staged as it is: with the Meta window closed, a template is
              the only thing that can be sent. */}
          <ComposerMoreMenu
            items={moreMenuItems.filter((item) => item.id === 'templates')}
            disabled={readOnly}
            title={readOnly ? t('readOnlyTitle') : undefined}
          />
          <div className="min-w-0 flex-1">
            <MediaDraftPreview
              draft={draft}
              busy={busy}
              readOnly={inputsDisabled}
              checking={checking}
              captionRef={captionRef}
              onCaptionChange={setCaption}
              onDiscard={discardDraft}
              onSend={sendDraft}
              t={t}
            />
          </div>
        </div>
      ) : (
        // WhatsApp-like row: More (+) | the text box with attach and AI
        // inside it | mic, which turns into Send once there is text. On
        // a 375px phone that leaves the box most of the width; every
        // other action lives in the More menu (`moreMenuItems`).
        <div className="flex items-end gap-1">
          <ComposerMoreMenu
            items={moreMenuItems}
            // Not inputsDisabled: with the Meta window closed, Templates
            // (in this menu) is the one way left to write.
            disabled={readOnly}
            title={readOnly ? t('readOnlyTitle') : undefined}
          />

          <div
            className={cn(
              'bg-wa-input flex min-w-0 flex-1 items-end rounded-lg',
              readOnly && 'cursor-not-allowed opacity-50'
            )}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              aria-autocomplete="list"
              aria-controls={
                slashOpen && slashMatches.length > 0 ? slashListId : undefined
              }
              aria-activedescendant={
                slashOpen && slashMatches.length > 0
                  ? slashOptionId(
                      slashListId,
                      Math.min(slashHighlight, slashMatches.length - 1)
                    )
                  : undefined
              }
              placeholder={
                readOnly
                  ? t('readOnlyPlaceholder')
                  : t('typeMessagePlaceholder')
              }
              disabled={inputsDisabled}
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
                'text-wa-text placeholder:text-wa-text-secondary min-h-10 min-w-0 flex-1 resize-none rounded-lg border-0 bg-transparent py-2.5 ps-3 pe-1 text-base leading-5 outline-none sm:text-[15px]',
                readOnly && 'cursor-not-allowed'
              )}
            />

            {/* Attach menu — photo / video / document. A voice note is
                the mic button. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={inputsDisabled || busy || voicePhase !== 'idle'}
                title={
                  readOnly
                    ? t('readOnlyTitle')
                    : inputsDisabled
                      ? undefined
                      : t('attachMedia')
                }
                aria-label={t('attachMedia')}
                className={PILL_BUTTON}
              >
                {busy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Paperclip className="h-5 w-5" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                className="border-border bg-popover w-auto min-w-40"
              >
                <DropdownMenuItem
                  onClick={() => imageInputRef.current?.click()}
                >
                  <ImageIcon className="me-2 h-4 w-4" />
                  {t('photo')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => videoInputRef.current?.click()}
                >
                  <Video className="me-2 h-4 w-4" />
                  {t('video')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => documentInputRef.current?.click()}
                >
                  <FileText className="me-2 h-4 w-4" />
                  {t('document')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* The draft button stays while there is text: it writes the
                reply from that text. */}
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={drafting || freeTextBlocked}
              title={
                readOnly
                  ? undefined
                  : text.trim()
                    ? t('draftFromTyped')
                    : t('draftWithAI')
              }
              aria-label={text.trim() ? t('draftFromTyped') : t('draftWithAI')}
              className={cn(PILL_BUTTON, 'hover:text-wa-teal')}
              onClick={handleDraft}
            >
              {drafting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
            </GatedButton>

            {/* Translate to Arabic: an icon on wider screens once there
                is something to translate, kept while a request is in
                flight so it doesn't vanish under the agent's cursor. On
                a phone it is a More menu item, so the box keeps its
                width. */}
            {showTranslate && (
              <GatedButton
                variant="ghost"
                size="sm"
                canAct={!readOnly}
                gateReason="send messages"
                disabled={translating || checking || freeTextBlocked}
                title={
                  readOnly
                    ? undefined
                    : translating
                      ? t('translatingToArabic')
                      : t('translateToArabic')
                }
                aria-label={
                  translating
                    ? t('translatingToArabic')
                    : t('translateToArabic')
                }
                aria-busy={translating || undefined}
                className={cn(PILL_BUTTON, 'hover:text-wa-teal max-sm:hidden')}
                onClick={handleTranslate}
              >
                {translating ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Languages className="h-5 w-5" />
                )}
              </GatedButton>
            )}
          </div>

          {/* Mic with an empty box, Send once there is text (or a check
              is running for the text just sent). An attachment has its
              own Send in the preview that replaces this row. Keyed apart:
              sharing one DOM node, the second tap of a double tap on Send
              started a recording (see `micTooSoon` too). */}
          {text.trim() || checking ? (
            <GatedButton
              key="send"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={!text.trim() || checking || freeTextBlocked}
              onClick={handleSend}
              className={SEND_BUTTON}
              aria-label={t('send')}
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
          ) : (
            <GatedButton
              key="mic"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={inputsDisabled || busy || voicePhase !== 'idle'}
              onClick={startRecording}
              title={
                readOnly
                  ? undefined
                  : ((freeTextBlocked ? freeTextBlockedText : null) ??
                    tVoice('record'))
              }
              aria-label={tVoice('record')}
              className={SEND_BUTTON}
            >
              <Mic className="h-[18px] w-[18px]" />
            </GatedButton>
          )}
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
                <Loader2 className="me-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="me-1 h-4 w-4" />
              )}
              {t('saveAsQuickReply')}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="me-1 h-4 w-4" />
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
      <VoiceLibraryPicker
        open={voiceLibraryOpen}
        onOpenChange={setVoiceLibraryOpen}
        conversationId={conversationId}
        onRecord={() => {
          setVoiceLibraryOpen(false);
          startRecording();
        }}
        onSend={(note) => {
          if (refuseBlocked()) return;
          onSendMedia({
            kind: 'audio',
            mediaUrl: note.mediaUrl,
            path: note.path,
            filename: 'voice-note.ogg',
            replyToId: replyTo?.id,
          });
        }}
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
  const tVoice = useTranslations('Inbox.voice');
  // A voice note is one row, like the recording bar it replaces:
  // discard, the player (to listen back before sending), send.
  if (draft.kind === 'audio') {
    return (
      <div className="bg-wa-input flex h-[64px] items-center gap-2 rounded-lg ps-1 pe-1.5">
        <button
          type="button"
          onClick={onDiscard}
          aria-label={tVoice('discardRecording')}
          title={tVoice('discardRecording')}
          className="text-wa-icon hover:bg-destructive-soft hover:text-destructive focus-visible:ring-destructive/50 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
        >
          <Trash2 className="h-5 w-5" />
        </button>
        <VoiceNotePlayer
          src={draft.mediaUrl}
          seed={draft.path ?? draft.filename}
          tone="in"
          badge={false}
          className="w-auto min-w-0 flex-1"
        />
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          aria-label={tVoice('sendVoice')}
          title={readOnly ? undefined : tVoice('sendVoice')}
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
            if (isImeKey(e.nativeEvent)) return;
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
