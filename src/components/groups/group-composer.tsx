'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Send,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QuickReplyPicker } from '@/components/inbox/quick-reply-picker';
import { VoiceNotePlayer } from '@/components/inbox/voice-note-player';
import {
  VoiceFailedStrip,
  VoiceRecordingBar,
  VoiceWorkStrip,
} from '@/components/inbox/voice-recording-bar';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import {
  MAX_RECORDING_SECONDS,
  micTooSoon,
  SEND_BUTTON,
  TOOL_BUTTON,
} from '@/lib/inbox/composer-ui';
import {
  groupFileKind,
  groupMediaMaxBytes,
  groupMediaPayload,
  groupPickerAccept,
  groupUploadName,
  isGroupUploadPath,
  megabytes,
  type GroupMediaDraft,
  type GroupMediaSendPayload,
  type GroupPickerKind,
} from '@/lib/groups/composer';
import { shouldSendOnKey } from '@/lib/groups/group-page';
import { groupTextDrafts, sendTyped } from '@/lib/groups/text-drafts';
import { createUnsentQueue, sendOrKeep } from '@/lib/groups/unsent-media';
import { createUnsentTakes } from '@/lib/inbox/unsent-takes';
import {
  GROUP_MEDIA_CAPTION_MAX,
  GROUP_MEDIA_FOLDER,
  type GroupOutboundKind,
} from '@/lib/groups/outbound-media';
import {
  deleteAccountMedia,
  uploadAccountMedia,
} from '@/lib/storage/upload-media';
import { cn } from '@/lib/utils';
import type { QuickReply } from '@/types';

export type { GroupMediaSendPayload } from '@/lib/groups/composer';

const BUCKET = 'chat-media';
const TEXT_MAX = 4096;

export interface GroupComposerProps {
  /** The chat, for a voice note kept until it can be uploaded. */
  chatKey: string;
  /** The chat's name, for a notice shown once it has been left. */
  chatName: string;
  /** Who is signed in: the only one it is kept for. */
  userId: string | null;
  /** Sends text; false when it was not sent (the text comes back). */
  onSendText: (text: string) => Promise<boolean>;
  /**
   * Sends an uploaded attachment; false puts it back in the composer.
   * Return true whenever a stored message may point at the file.
   */
  onSendMedia: (payload: GroupMediaSendPayload) => Promise<boolean>;
  disabled?: boolean;
  /** Shown above the composer while it is disabled. */
  disabledReason?: string | null;
  /** Shown above the composer while it is enabled (e.g. "Sent as …"). */
  notice?: string | null;
  placeholder?: string;
}

type SendMedia = GroupComposerProps['onSendMedia'];

/** A recording and what Send captured: null is listened to first. */
interface VoiceFile {
  file: File;
  deliver: SendMedia | null;
}

/** An uploaded attachment; `refused`: its send came back once. */
type StagedMedia = GroupMediaDraft & { refused?: true };

/** Recordings that are not sent, by chat. */
const unsentVoices = createUnsentTakes<VoiceFile>();

/** Attachments whose send was refused after the chat was left. */
const unsentMedia = createUnsentQueue<StagedMedia>();

/** Best effort: an upload nobody will send is removed from the bucket. */
function removeUpload(path: string | undefined) {
  if (path) void deleteAccountMedia(BUCKET, path).catch(() => {});
}

/**
 * A WhatsApp group's composer: text, attachments (photo, video, document,
 * voice note) and quick replies, laid out like the inbox composer.
 * Generic: the caller decides where a message goes. Attachments upload
 * into `chat-media` under `account-<id>/groups/`, never `staged/`.
 */
export function GroupComposer({
  chatKey,
  chatName,
  userId,
  onSendText,
  onSendMedia,
  disabled = false,
  disabledReason,
  notice,
  placeholder,
}: GroupComposerProps) {
  const t = useTranslations('Inbox.composer');
  const tv = useTranslations('Inbox.voice');
  const tg = useTranslations('Groups.page.chat');
  // The box's words live outside it, by chat (lib/groups/text-drafts).
  const readText = () => groupTextDrafts.get(userId, chatKey);
  const text = useSyncExternalStore(
    groupTextDrafts.subscribe,
    readText,
    readText
  );
  const setText = (next: string) =>
    groupTextDrafts.write(userId, chatKey, next);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<StagedMedia | null>(null);
  const draftRef = useRef<StagedMedia | null>(null);
  draftRef.current = draft;
  const chatRef = useRef({ userId, chatKey });
  chatRef.current = { userId, chatKey };
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const captionRef = useRef<HTMLInputElement>(null);
  const inputs = {
    image: useRef<HTMLInputElement>(null),
    video: useRef<HTMLInputElement>(null),
    document: useRef<HTMLInputElement>(null),
  };

  // A recording being sent or made ready, and one whose upload failed.
  const [voiceWork, setVoiceWork] = useState<'send' | 'review' | null>(null);
  useLayoutEffect(() => {
    unsentVoices.claim(userId);
    unsentMedia.claim(userId);
    groupTextDrafts.claim(userId);
  }, [userId]);
  const unsentVoice = useSyncExternalStore(
    unsentVoices.subscribe,
    () => unsentVoices.get(userId, chatKey),
    () => null
  );
  const mountedRef = useRef(true);
  const lastSentAtRef = useRef(0);

  // Leaving removes an upload that was never sent (the recorder frees
  // the mic by itself); one the group refused waits here.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const left = draftRef.current;
      const { userId, chatKey } = chatRef.current;
      if (left?.refused && unsentMedia.add(userId, chatKey, left)) return;
      removeUpload(left?.path);
    };
  }, []);

  const waiting = useSyncExternalStore(
    unsentMedia.subscribe,
    () => unsentMedia.first(userId, chatKey),
    () => null
  );

  /** Throws when the file cannot be uploaded. */
  const upload = useCallback(
    async (kind: GroupOutboundKind, file: File): Promise<GroupMediaDraft> => {
      // Uploaded under a cleaned name so the path is one the send
      // route accepts; the picked name is what the group sees.
      const named = new File([file], groupUploadName(file.name), {
        type: file.type,
      });
      const { publicUrl, path } = await uploadAccountMedia(BUCKET, named, {
        subfolder: GROUP_MEDIA_FOLDER,
      });
      if (!isGroupUploadPath(path)) {
        removeUpload(path);
        throw new Error('unexpected upload path');
      }
      return {
        kind,
        url: publicUrl,
        path,
        filename: file.name,
        mimeType: file.type,
        caption: '',
      };
    },
    []
  );

  /** Into the composer, unless it is gone. */
  const land = useCallback((staged: GroupMediaDraft) => {
    if (!mountedRef.current) {
      removeUpload(staged.path);
      return;
    }
    removeUpload(draftRef.current?.path);
    setDraft(staged);
    requestAnimationFrame(() => captionRef.current?.focus());
  }, []);

  const tooLarge = useCallback(
    (kind: GroupOutboundKind, file: File) => {
      const max = groupMediaMaxBytes(kind);
      if (file.size <= max) return false;
      toast.error(
        tg('fileTooLarge', {
          size: megabytes(file.size),
          limit: megabytes(max),
        })
      );
      return true;
    },
    [tg]
  );

  const stage = useCallback(
    async (kind: GroupOutboundKind, file: File) => {
      if (tooLarge(kind, file)) return;
      setBusy(true);
      try {
        land(await upload(kind, file));
      } catch {
        toast.error(tg('uploadFailed'));
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [tg, tooLarge, land, upload]
  );

  const handlePicked = (picked: GroupPickerKind, file: File | undefined) => {
    if (!file) return;
    const kind = groupFileKind(picked, file.type);
    if (!kind) {
      toast.error(tg('fileTypeNotAllowed'));
      return;
    }
    void stage(kind, file);
  };

  // ---- Sending -------------------------------------------------------

  /** Sends what is uploaded; not sent, it comes back to the composer. */
  const sendUploaded = useCallback(
    (staged: StagedMedia, deliver: SendMedia, voice?: VoiceFile) =>
      sendOrKeep(staged, (it) => deliver(groupMediaPayload(it)), {
        toComposer: (it) => {
          if (!mountedRef.current || draftRef.current) return false;
          const back: StagedMedia = { ...it, refused: true };
          draftRef.current = back;
          setDraft(back);
          return true;
        },
        // One recording waits per chat: a second stays an attachment.
        keepRecording: () =>
          !!voice &&
          !mountedRef.current &&
          !unsentVoices.get(userId, chatKey) &&
          unsentVoices.put(userId, chatKey, voice),
        keepUpload: (it) =>
          unsentMedia.add(userId, chatKey, { ...it, refused: true }),
        remove: (it) => removeUpload(it.path),
        onKept: () => {
          if (!mountedRef.current) {
            toast.error(tg('notSentIn', { group: chatName }));
          }
        },
      }),
    [userId, chatKey, chatName, tg]
  );

  // ---- Voice note (Ogg/Opus in the browser, as the inbox) -----------

  // A finished recording: uploaded, then sent (by the group's own send,
  // captured when Send was pressed) or staged to be listened to.
  const sendOrStageVoice = useCallback(
    async (voice: VoiceFile) => {
      setBusy(true);
      setVoiceWork(voice.deliver ? 'send' : 'review');
      let staged: GroupMediaDraft;
      try {
        staged = await upload('voice', voice.file);
      } catch {
        // Kept for this chat, which says so; elsewhere a notice does.
        const kept = unsentVoices.put(userId, chatKey, voice);
        if (mountedRef.current) setVoiceWork(null);
        else if (kept) toast.error(tg('notSentIn', { group: chatName }));
        return;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
      if (!voice.deliver) {
        if (mountedRef.current) setVoiceWork(null);
        land(staged);
        return;
      }
      lastSentAtRef.current = Date.now();
      await sendUploaded(staged, voice.deliver, voice);
      if (mountedRef.current) setVoiceWork(null);
    },
    [upload, land, sendUploaded, tg, chatName, userId, chatKey]
  );

  const {
    phase: voicePhase,
    seconds: recordSeconds,
    start: startTake,
    finish: finishTake,
    cancel: cancelRecording,
    getLevelSource,
  } = useVoiceRecorder<{ deliver: SendMedia | null }>({
    maxSeconds: MAX_RECORDING_SECONDS,
    onTake: (take) => {
      const file = new File(
        [take.bytes as unknown as BlobPart],
        `voice-${Date.now()}.ogg`,
        { type: 'audio/ogg' }
      );
      if (tooLarge('voice', file)) {
        setVoiceWork(null);
        return;
      }
      void sendOrStageVoice({ file, deliver: take.meta.deliver });
    },
    onProblem: (problem) => {
      setVoiceWork(null);
      toast.error(tv(`problem.${problem}`));
    },
  });
  const recording = voicePhase === 'starting' || voicePhase === 'recording';

  // What this chat refused is offered again, once nothing else is there.
  const free =
    !draft && !sending && !busy && !voiceWork && voicePhase === 'idle';
  useEffect(() => {
    if (!waiting || !free) return;
    const back = unsentMedia.take(userId, chatKey);
    if (!back) return;
    draftRef.current = back;
    setDraft(back);
  }, [waiting, free, userId, chatKey]);

  // The text box grows with its text, up to about six lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text, draft, recording]);

  const startRecording = () => {
    if (disabled || busy) return;
    if (micTooSoon(lastSentAtRef.current, Date.now())) return;
    // One recording waits per chat, and nothing staged is replaced: what
    // is there goes first.
    if (unsentVoice || draftRef.current) {
      toast.info(tv(unsentVoice ? 'keptFirst' : 'draftFirst'));
      return;
    }
    void startTake({ deliver: null });
  };

  const listenFirst = () => {
    if (finishTake('review')) setVoiceWork('review');
  };

  const sendRecording = () => {
    // No longer allowed to send here: kept, to be listened to.
    if (disabled) {
      listenFirst();
      return;
    }
    if (!finishTake('send', { deliver: onSendMedia })) return;
    lastSentAtRef.current = Date.now();
    setVoiceWork('send');
  };

  const retryVoice = () => {
    if (!unsentVoice || busy || disabled) return;
    unsentVoices.remove(chatKey);
    void sendOrStageVoice({
      file: unsentVoice.file,
      deliver: unsentVoice.deliver && onSendMedia,
    });
  };

  const sendText = async () => {
    if (!text.trim() || sending || disabled) return;
    setSending(true);
    lastSentAtRef.current = Date.now();
    try {
      await sendTyped(groupTextDrafts, userId, chatKey, onSendText);
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const sendDraft = async () => {
    const staged = draftRef.current;
    if (!staged || busy || sending || disabled) return;
    setSending(true);
    lastSentAtRef.current = Date.now();
    setDraft(null);
    draftRef.current = null;
    await sendUploaded(staged, onSendMedia);
    if (mountedRef.current) setSending(false);
  };

  const discardDraft = () => {
    removeUpload(draftRef.current?.path);
    draftRef.current = null;
    setDraft(null);
  };

  const pickQuickReply = (qr: QuickReply) => {
    setQuickReplyOpen(false);
    // Interactive snippets need the inbox's builder; groups take text.
    const body = qr.content_text ?? '';
    if (!body) return;
    const now = readText();
    setText(now && !/\s$/.test(now) ? `${now}\n${body}` : `${now}${body}`);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const pickers: GroupPickerKind[] = ['image', 'video', 'document'];

  return (
    <div className="border-wa-divider bg-wa-panel-header shrink-0 border-t px-2 py-2 sm:px-4">
      {(disabled ? disabledReason : notice) && (
        <p role="status" className="text-muted-foreground px-1 pb-2 text-xs">
          {disabled ? disabledReason : notice}
        </p>
      )}
      {pickers.map((kind) => (
        <input
          key={kind}
          ref={inputs[kind]}
          type="file"
          accept={groupPickerAccept(kind)}
          className="hidden"
          onChange={(e) => {
            handlePicked(kind, e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      ))}

      {unsentVoice && (
        <VoiceFailedStrip
          // Listened to first, it would replace what is staged now.
          disabled={
            busy ||
            disabled ||
            voicePhase !== 'idle' ||
            (!!draft && !unsentVoice.deliver)
          }
          onRetry={retryVoice}
          onDiscard={() => unsentVoices.remove(chatKey)}
        />
      )}
      {voiceWork && <VoiceWorkStrip kind={voiceWork} />}

      {recording ? (
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
        <GroupDraftPreview
          draft={draft}
          busy={busy || sending || disabled}
          captionRef={captionRef}
          onCaptionChange={(caption) =>
            setDraft((d) => (d ? { ...d, caption } : d))
          }
          onDiscard={discardDraft}
          onSend={() => void sendDraft()}
          t={t}
        />
      ) : (
        <div className="flex items-end gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled || busy || voicePhase !== 'idle'}
              title={t('attachMedia')}
              aria-label={t('attachMedia')}
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
              <DropdownMenuItem onClick={() => inputs.image.current?.click()}>
                <ImageIcon className="me-2 h-4 w-4" />
                {t('photo')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => inputs.video.current?.click()}>
                <Video className="me-2 h-4 w-4" />
                {t('video')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => inputs.document.current?.click()}
              >
                <FileText className="me-2 h-4 w-4" />
                {t('document')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={voicePhase !== 'idle'}
                onClick={startRecording}
              >
                <Mic className="me-2 h-4 w-4" />
                {tv('record')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled}
              title={t('moreActions')}
              aria-label={t('moreActions')}
              className={TOOL_BUTTON}
            >
              <Plus className="h-5 w-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="me-2 h-4 w-4" />
                {t('quickReplies')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSendOnKey(e.nativeEvent)) {
                e.preventDefault();
                void sendText();
              }
            }}
            placeholder={placeholder ?? t('typeMessagePlaceholder')}
            aria-label={placeholder ?? t('typeMessagePlaceholder')}
            disabled={disabled}
            rows={1}
            maxLength={TEXT_MAX}
            dir="auto"
            className={cn(
              'bg-wa-input text-wa-text placeholder:text-wa-text-secondary min-h-10 flex-1 resize-none rounded-lg border-0 px-3 py-2.5 text-base leading-5 outline-none sm:text-[15px]',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          />

          {/* Mic with an empty box, Send once there is text, keyed apart,
              as in the inbox. */}
          {text.trim() || sending ? (
            <Button
              key="send"
              size="sm"
              aria-label={t('send')}
              disabled={disabled || sending || !text.trim()}
              onClick={() => void sendText()}
              className={SEND_BUTTON}
            >
              <Send className="h-[18px] w-[18px]" />
            </Button>
          ) : (
            <Button
              key="mic"
              size="sm"
              aria-label={tv('record')}
              title={tv('record')}
              disabled={disabled || busy || voicePhase !== 'idle'}
              onClick={startRecording}
              className={SEND_BUTTON}
            >
              <Mic className="h-[18px] w-[18px]" />
            </Button>
          )}
        </div>
      )}

      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={pickQuickReply}
      />
    </div>
  );
}

/**
 * The uploaded attachment with its caption, as the inbox's
 * `MediaDraftPreview`. Module scope so the caption input keeps focus
 * across the composer's re-renders.
 */
function GroupDraftPreview({
  draft,
  busy,
  captionRef,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: GroupMediaDraft;
  busy: boolean;
  captionRef: Ref<HTMLInputElement>;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tv = useTranslations('Inbox.voice');
  if (draft.kind === 'voice') {
    return (
      <div className="bg-wa-input flex h-[64px] items-center gap-2 rounded-lg ps-1 pe-1.5">
        <button
          type="button"
          onClick={onDiscard}
          aria-label={tv('discardRecording')}
          title={tv('discardRecording')}
          className="text-wa-icon hover:bg-destructive-soft hover:text-destructive focus-visible:ring-destructive/50 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
        >
          <Trash2 className="h-5 w-5" />
        </button>
        <VoiceNotePlayer
          src={draft.url}
          seed={draft.path}
          tone="in"
          badge={false}
          className="w-auto min-w-0 flex-1"
        />
        <Button
          size="sm"
          aria-label={tv('sendVoice')}
          title={tv('sendVoice')}
          disabled={busy}
          onClick={onSend}
          className={SEND_BUTTON}
        >
          <Send className="h-[18px] w-[18px]" />
        </Button>
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
              src={draft.url}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === 'video' && (
            <video src={draft.url} controls className="max-h-40 rounded-lg" />
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
          maxLength={GROUP_MEDIA_CAPTION_MAX}
          onChange={(e) => onCaptionChange(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSendOnKey(e.nativeEvent)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={t('addCaption')}
          aria-label={t('addCaption')}
          dir="auto"
          className="bg-wa-panel-header text-wa-text placeholder:text-wa-text-secondary flex-1 rounded-lg border-0 px-3 py-2.5 text-[15px] outline-none"
        />
        <Button
          size="sm"
          aria-label={t('send')}
          disabled={busy}
          onClick={onSend}
          className={SEND_BUTTON}
        >
          <Send className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </div>
  );
}
