'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { VoiceRecordingBar } from '@/components/inbox/voice-recording-bar';
import {
  MAX_RECORDING_SECONDS,
  OPUS_ENCODER_PATH,
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
  onSendText,
  onSendMedia,
  disabled = false,
  disabledReason,
  notice,
  placeholder,
}: GroupComposerProps) {
  const t = useTranslations('Inbox.composer');
  const tg = useTranslations('Groups.page.chat');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<GroupMediaDraft | null>(null);
  const draftRef = useRef<GroupMediaDraft | null>(null);
  draftRef.current = draft;
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const captionRef = useRef<HTMLInputElement>(null);
  const inputs = {
    image: useRef<HTMLInputElement>(null),
    video: useRef<HTMLInputElement>(null),
    document: useRef<HTMLInputElement>(null),
  };

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Leaving releases the mic and removes an upload that was never sent.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      cancelledRef.current = true;
      void recorderRef.current?.stop().catch(() => {});
      removeUpload(draftRef.current?.path);
    };
  }, [clearTimer]);

  // The text box grows with its text, up to about six lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text, draft, recording]);

  const stage = useCallback(
    async (kind: GroupOutboundKind, file: File) => {
      const max = groupMediaMaxBytes(kind);
      if (file.size > max) {
        toast.error(
          tg('fileTooLarge', {
            size: megabytes(file.size),
            limit: megabytes(max),
          })
        );
        return;
      }
      setBusy(true);
      try {
        // Uploaded under a cleaned name so the path is one the send
        // route accepts; the picked name is what the group sees.
        const upload = new File([file], groupUploadName(file.name), {
          type: file.type,
        });
        const { publicUrl, path } = await uploadAccountMedia(BUCKET, upload, {
          subfolder: GROUP_MEDIA_FOLDER,
        });
        if (!isGroupUploadPath(path) || !mountedRef.current) {
          removeUpload(path);
          if (mountedRef.current) toast.error(tg('uploadFailed'));
          return;
        }
        removeUpload(draftRef.current?.path);
        setDraft({
          kind,
          url: publicUrl,
          path,
          filename: file.name,
          mimeType: file.type,
          caption: '',
        });
        requestAnimationFrame(() => captionRef.current?.focus());
      } catch {
        toast.error(tg('uploadFailed'));
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [tg]
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

  // ---- Voice note (Ogg/Opus in the browser, as the inbox) -----------

  const startRecording = useCallback(async () => {
    // `recording` only turns true after the permission prompt: a second
    // tap meanwhile would start a second recorder and leave its mic on.
    if (disabled || busy || recording || startingRef.current) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      toast.error(tg('recordingUnsupported'));
      return;
    }
    startingRef.current = true;
    try {
      const { default: Recorder } = await import('opus-recorder');
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        const file = new File(
          [bytes as unknown as BlobPart],
          `voice-${Date.now()}.ogg`,
          { type: 'audio/ogg' }
        );
        if (file.size === 0) return;
        void stage('voice', file);
      };
      recorderRef.current = recorder;
      await recorder.start();
      if (!mountedRef.current) {
        // Left while the mic was being granted: release it.
        cancelledRef.current = true;
        void recorder.stop().catch(() => {});
        recorderRef.current = null;
        return;
      }
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      if (mountedRef.current) toast.error(tg('micDenied'));
    } finally {
      startingRef.current = false;
    }
  }, [disabled, busy, recording, stage, tg]);

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

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) stopRecording();
  }, [recording, recordSeconds, stopRecording]);

  // ---- Sending -------------------------------------------------------

  const sendText = async () => {
    const body = text.trim();
    if (!body || sending || disabled) return;
    setSending(true);
    setText('');
    try {
      const ok = await onSendText(body);
      // Not sent: give the words back unless something was typed since.
      if (!ok && mountedRef.current) setText((now) => now || body);
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const sendDraft = async () => {
    const staged = draftRef.current;
    if (!staged || busy || sending || disabled) return;
    setSending(true);
    setDraft(null);
    draftRef.current = null;
    // Not sent: put the attachment back (as text is), unless another was
    // staged meanwhile or the composer is gone; only then delete it.
    const giveBack = () => {
      if (mountedRef.current && !draftRef.current) {
        draftRef.current = staged;
        setDraft(staged);
      } else {
        removeUpload(staged.path);
      }
    };
    try {
      const ok = await onSendMedia(groupMediaPayload(staged));
      if (!ok) giveBack();
    } catch {
      giveBack();
    } finally {
      if (mountedRef.current) setSending(false);
    }
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
    setText((prev) =>
      prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`
    );
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

      {draft ? (
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
      ) : recording ? (
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
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled || busy}
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
              <DropdownMenuItem onClick={() => void startRecording()}>
                <Mic className="me-2 h-4 w-4" />
                {t('voiceNote')}
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

          <Button
            size="sm"
            aria-label={t('send')}
            disabled={disabled || sending || !text.trim()}
            onClick={() => void sendText()}
            className={SEND_BUTTON}
          >
            <Send className="h-[18px] w-[18px]" />
          </Button>
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
  if (draft.kind === 'voice') {
    return (
      <div className="bg-wa-input flex h-[64px] items-center gap-2 rounded-lg pe-1.5 ps-1">
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
          src={draft.url}
          seed={draft.path}
          tone="in"
          className="w-auto min-w-0 flex-1"
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
