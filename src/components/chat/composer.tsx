'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  Bold,
  Code,
  FileText,
  Italic,
  List,
  Loader2,
  MessageCircle,
  Mic,
  Paperclip,
  Quote,
  Strikethrough,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import {
  CHAT_FILE_MAX_BYTES,
  postMessage,
  uploadChatFile,
  type AttachmentInput,
  type SharedCard,
} from '@/lib/chat';
import {
  acceptFiles,
  blockFromError,
  composeBody,
  decodeDraft,
  draftStorageKey,
  encodeDraft,
  type ComposerBlock,
  type ComposerDraft,
} from '@/lib/chat/composer';
import {
  chipInputs,
  chipsReady,
  EMPTY_DRAFT,
  helperLine,
  offersBroadcasts,
  settleChip,
  uploadingChip,
  type FileChip,
} from '@/lib/chat/composer-input';
import {
  channelDisplayName,
  chatErrorKey,
  inboxBasePath,
} from '@/lib/chat/view';
import type { FormatAction } from '@/lib/chat/format';
import {
  CHAT_VOICE_MAX_SECONDS,
  voiceAttachment,
  voiceDurationMs,
  voiceFileName,
} from '@/lib/chat/voice';
import { formatClock } from '@/lib/media/voice-waveform';
import { cn } from '@/lib/utils';
import { VoiceNotePlayer } from '@/components/inbox/voice-note-player';
import { VoiceRecordingBar } from '@/components/inbox/voice-recording-bar';

import { useChatWorkspaceContext } from './chat-context';
import {
  MentionTextarea,
  type MentionTextareaControl,
} from './mention-textarea';
import { useWriteBlock } from './use-write-block';

export interface ComposerProps {
  channelId: string;
  /** Thread mode: replies to this root. */
  threadRootId?: string | null;
  /** The thread root's shared conversation, for the WhatsApp link. */
  sharedCard?: SharedCard | null;
  onPosted?: (messageId: string) => void;
}

const FORMAT_BAR_KEY = 'chat.formatBar';

/** The Ogg/Opus encoder worker the inbox composer uses too (in /public). */
const OPUS_ENCODER_PATH = '/opus/encoderWorker.min.js';

/**
 * A recorded take awaiting Send. It lives only in the browser until then
 * (a discarded take uploads nothing); `uploaded` keeps a finished upload
 * so a retry after a failed post does not upload it twice.
 */
interface VoiceTake {
  file: File;
  url: string;
  durationMs: number;
  uploaded: AttachmentInput | null;
}

const FORMAT_BUTTONS: {
  action: FormatAction;
  Icon: typeof Bold;
  label: 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'bulletList';
  shortcut?: string;
}[] = [
  { action: 'bold', Icon: Bold, label: 'bold', shortcut: 'Ctrl+B' },
  { action: 'italic', Icon: Italic, label: 'italic', shortcut: 'Ctrl+I' },
  {
    action: 'strike',
    Icon: Strikethrough,
    label: 'strike',
    shortcut: 'Ctrl+Shift+X',
  },
  { action: 'code', Icon: Code, label: 'code', shortcut: 'Ctrl+E' },
  { action: 'quote', Icon: Quote, label: 'quote' },
  { action: 'bullets', Icon: List, label: 'bulletList' },
];

function readDraft(key: string): ComposerDraft {
  try {
    return decodeDraft(window.localStorage.getItem(key));
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(key: string, draft: ComposerDraft) {
  try {
    const raw = encodeDraft(draft);
    if (raw) window.localStorage.setItem(key, raw);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked (private window): the draft lives in memory only.
  }
}

/** The team-chat composer of a channel or a thread. Mount it with key={channelId}. */
export function Composer({
  channelId,
  threadRootId = null,
  sharedCard = null,
  onPosted,
}: ComposerProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const { accountRole } = useAuth();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const block = useWriteBlock(channel);
  const [refused, setRefused] = useState<ComposerBlock | null>(null);
  const storageKey = draftStorageKey(channelId, threadRootId);
  const [draft, setDraft] = useState<ComposerDraft>(() =>
    readDraft(storageKey)
  );
  const [chips, setChips] = useState<FileChip[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<MentionTextareaControl>(null);
  const [formatBar, setFormatBar] = useState(false);

  // ---- Voice notes: record, review, then upload on Send -------------
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [take, setTake] = useState<VoiceTake | null>(null);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  // Set before any stop that must not stage a take (cancel, unmount).
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // performance.now() when recorder.start() resolved; the take's length
  // is measured from it to the Stop press.
  const startedAtRef = useRef<number | null>(null);
  const durationRef = useRef(0);
  const takeUrlRef = useRef<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** stop() is what releases the mic stream and audio context. */
  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    void recorder?.stop().catch(() => {});
  }, []);

  const dropTake = useCallback(() => {
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    takeUrlRef.current = null;
    setTake(null);
  }, []);

  // Switching channel unmounts the composer (key={channelId}): a live
  // recording is cancelled, the mic released and a staged take dropped.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelledRef.current = true;
      clearTimer();
      stopRecorder();
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
      takeUrlRef.current = null;
    };
  }, [clearTimer, stopRecorder]);

  const stageTake = (bytes: Uint8Array) => {
    if (cancelledRef.current || !aliveRef.current) return;
    // Uint8Array is a BlobPart at runtime; the cast sidesteps lib.dom's
    // ArrayBufferLike-vs-ArrayBuffer generic mismatch.
    const file = new File(
      [bytes as unknown as BlobPart],
      voiceFileName(new Date()),
      { type: 'audio/ogg' }
    );
    if (file.size === 0) return;
    if (file.size > CHAT_FILE_MAX_BYTES) {
      toast.error(t('voice.tooLarge'));
      return;
    }
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    const url = URL.createObjectURL(file);
    takeUrlRef.current = url;
    setTake({ file, url, durationMs: durationRef.current, uploaded: null });
  };

  const startRecording = async () => {
    if (recording || startingRef.current || sending || take) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      toast.error(t('voice.unsupported'));
      return;
    }
    startingRef.current = true;
    try {
      // Lazy: the encoder stays out of the bundle until someone records.
      const { default: Recorder } = await import('opus-recorder');
      if (!aliveRef.current) return;
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP: tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the whole file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = stageTake;
      recorderRef.current = recorder;
      await recorder.start();
      // Unmounted (or cancelled) while the permission prompt was open.
      if (!aliveRef.current || recorderRef.current !== recorder) {
        cancelledRef.current = true;
        void recorder.stop().catch(() => {});
        return;
      }
      const startedAt = performance.now();
      startedAtRef.current = startedAt;
      setRecordSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(
        () =>
          setRecordSeconds(Math.floor((performance.now() - startedAt) / 1000)),
        1000
      );
    } catch {
      cancelledRef.current = true;
      stopRecorder();
      if (aliveRef.current) toast.error(t('voice.micDenied'));
    } finally {
      startingRef.current = false;
    }
  };

  const stopRecording = useCallback(() => {
    const startedAt = startedAtRef.current;
    startedAtRef.current = null;
    if (startedAt !== null)
      durationRef.current = voiceDurationMs(startedAt, performance.now());
    clearTimer();
    setRecording(false);
    stopRecorder();
  }, [clearTimer, stopRecorder]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    startedAtRef.current = null;
    clearTimer();
    setRecording(false);
    stopRecorder();
  }, [clearTimer, stopRecorder]);

  // The meter taps the recorder's own graph.
  const getLevelSource = useCallback(() => recorderRef.current, []);

  // A forgotten recording stops itself at the cap.
  useEffect(() => {
    if (recording && recordSeconds >= CHAT_VOICE_MAX_SECONDS) stopRecording();
  }, [recording, recordSeconds, stopRecording]);

  // Escape cancels a live recording, and only that (not the thread panel).
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, cancelRecording]);

  // A composer that becomes blocked (archived, removed from the channel)
  // stops listening at once.
  const writeBlocked = !channel || !!(refused ?? block);
  useEffect(() => {
    if (writeBlocked) cancelRecording();
  }, [writeBlocked, cancelRecording]);
  useEffect(() => {
    try {
      setFormatBar(window.localStorage.getItem(FORMAT_BAR_KEY) === '1');
    } catch {
      // Storage blocked: the toolbar starts closed.
    }
  }, []);
  const toggleFormatBar = () => {
    const next = !formatBar;
    setFormatBar(next);
    try {
      window.localStorage.setItem(FORMAT_BAR_KEY, next ? '1' : '0');
    } catch {
      // Not persisted.
    }
  };

  if (!channel) return null;

  const changeDraft = (d: ComposerDraft) => {
    setDraft(d);
    writeDraft(storageKey, d);
  };

  const addFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = '';
    const accountId = ws.accountId;
    if (!files.length || !accountId) return;
    const { accepted, rejected } = acceptFiles(chips.length, files);
    if (rejected) toast.error(t(`errors.${rejected}`));
    const added = accepted.map((f) =>
      uploadingChip(crypto.randomUUID(), f.name)
    );
    setChips((c) => [...c, ...added]);
    added.forEach((chip, i) => {
      uploadChatFile(ws.sb, { accountId, channelId, file: accepted[i] })
        .then((input) => setChips((c) => settleChip(c, chip.id, { input })))
        .catch((err) =>
          setChips((c) => settleChip(c, chip.id, { error: chatErrorKey(err) }))
        );
    });
  };

  const composed = composeBody(
    draft.text,
    draft.picked,
    chips.map((c) => c.name)
  );
  const canSend =
    !sending &&
    chipsReady(chips) &&
    (composed.ok || composed.reason === 'bodyLength');

  const send = async () => {
    if (!canSend) return;
    if (!composed.ok) {
      toast.error(t('errors.bodyLength'));
      return;
    }
    setSending(true);
    try {
      const id = await postMessage(ws.sb, {
        channelId,
        body: composed.body,
        threadRootId,
        attachments: chipInputs(chips),
      });
      changeDraft(EMPTY_DRAFT);
      setChips([]);
      onPosted?.(id);
    } catch (err) {
      const b = blockFromError(chatErrorKey(err));
      if (b) setRefused(b);
      else ws.fail(err);
    } finally {
      setSending(false);
    }
  };

  const sendVoice = async () => {
    const accountId = ws.accountId;
    if (!take || sending || !accountId) return;
    const staged = take;
    setSending(true);
    try {
      let uploaded = staged.uploaded;
      if (!uploaded) {
        uploaded = await uploadChatFile(ws.sb, {
          accountId,
          channelId,
          file: staged.file,
        });
        const done = uploaded;
        setTake((cur) =>
          cur?.url === staged.url ? { ...cur, uploaded: done } : cur
        );
      }
      const id = await postMessage(ws.sb, {
        channelId,
        body: t('voice.body', {
          duration: formatClock(
            Math.max(1, Math.round(staged.durationMs / 1000))
          ),
        }),
        threadRootId,
        attachments: [voiceAttachment(uploaded, staged.durationMs)],
      });
      dropTake();
      onPosted?.(id);
    } catch (err) {
      const key = chatErrorKey(err);
      // The object is gone after all: the retry uploads it again.
      if (key === 'attachmentMissing')
        setTake((cur) =>
          cur?.url === staged.url ? { ...cur, uploaded: null } : cur
        );
      const b = blockFromError(key);
      if (b) setRefused(b);
      else ws.fail(err);
    } finally {
      setSending(false);
    }
  };

  const whatsapp =
    threadRootId && sharedCard?.canOpen ? (
      <Link
        href={`${inboxBasePath(accountRole)}?c=${sharedCard.conversationId}`}
        className="text-warning mt-2 inline-flex items-center gap-1.5 text-xs font-semibold hover:underline"
      >
        <MessageCircle className="size-3.5" aria-hidden />
        {t('composer.whatsappInstead')}
      </Link>
    ) : null;

  const shown = refused ?? block;
  if (shown)
    return (
      <div className="border-t px-4 py-3 text-center">
        <p className="text-muted-foreground text-sm">
          {t(`composer.blocked.${shown}`)}
        </p>
        {whatsapp}
      </div>
    );

  const name = channelDisplayName(
    channel,
    ws.userId ?? '',
    ws.peopleById,
    t('unknownPerson')
  );
  const helper = helperLine(channel.kind, name, !!threadRootId);

  return (
    <div className="border-t px-4 pt-2 pb-3">
      <p className="text-muted-foreground mb-1.5 truncate text-xs">
        {t(
          `composer.${helper.key}`,
          helper.key === 'helperChannel'
            ? { name: helper.name }
            : helper.key === 'helperDm'
              ? { names: helper.names }
              : {}
        )}
      </p>
      {chips.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li
              key={chip.id}
              title={chip.error ? t(`errors.${chip.error}`) : undefined}
              className={cn(
                'flex max-w-60 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
                chip.status === 'failed' &&
                  'border-destructive text-destructive'
              )}
            >
              {chip.status === 'uploading' ? (
                <Loader2
                  className="size-3.5 shrink-0 animate-spin"
                  aria-hidden
                />
              ) : chip.status === 'failed' ? (
                <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <FileText
                  className="text-muted-foreground size-3.5 shrink-0"
                  aria-hidden
                />
              )}
              <span className="min-w-0 truncate">{chip.name}</span>
              <span
                className={cn(
                  'shrink-0',
                  chip.status === 'done'
                    ? 'sr-only'
                    : chip.status === 'uploading' && 'text-muted-foreground'
                )}
              >
                {t(
                  chip.status === 'uploading'
                    ? 'composer.fileUploading'
                    : chip.status === 'failed'
                      ? 'composer.fileFailed'
                      : 'composer.fileUploaded'
                )}
              </span>
              <button
                type="button"
                aria-label={t('composer.removeFile', { name: chip.name })}
                onClick={() =>
                  setChips((c) => c.filter((x) => x.id !== chip.id))
                }
                className="hover:bg-muted -mr-1 rounded p-0.5"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {formatBar && !recording && !take && (
        <div
          role="toolbar"
          aria-label={t('composer.formatting')}
          className="flex items-center gap-1"
        >
          {FORMAT_BUTTONS.map(({ action, Icon, label, shortcut }) => {
            const name = t(`composer.${label}`);
            const full = shortcut ? `${name} (${shortcut})` : name;
            return (
              <button
                key={action}
                type="button"
                aria-label={full}
                title={full}
                // mousedown, not click: the textarea keeps its selection.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => input.current?.format(action)}
                className="hover:bg-muted flex size-7 items-center justify-center rounded-md border"
              >
                <Icon className="size-3.5" aria-hidden />
              </button>
            );
          })}
        </div>
      )}
      {recording ? (
        <VoiceRecordingBar
          seconds={recordSeconds}
          maxSeconds={CHAT_VOICE_MAX_SECONDS}
          getLevelSource={getLevelSource}
          onCancel={cancelRecording}
          onStop={stopRecording}
          stopClassName="bg-primary text-primary-foreground hover:bg-primary-hover size-9 shrink-0 rounded-lg"
        />
      ) : take ? (
        // The text draft stays in state (and storage) while a take is
        // staged; the textarea comes back with it after send or discard.
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('voice.discard')}
            title={t('voice.discard')}
            onClick={dropTake}
            disabled={sending}
            className="hover:bg-destructive-soft hover:text-destructive flex size-9 shrink-0 items-center justify-center rounded-lg border disabled:opacity-50"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
          <VoiceNotePlayer
            src={take.url}
            seed={take.url}
            tone="chat"
            knownDuration={take.durationMs / 1000}
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={() => void sendVoice()}
            disabled={sending}
            aria-busy={sending}
            className="bg-primary text-primary-foreground hover:bg-primary-hover inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold disabled:opacity-50"
          >
            {sending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t(sending ? 'voice.sending' : 'voice.send')}
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <button
            type="button"
            aria-label={t('composer.attach')}
            title={t('composer.attach')}
            onClick={() => fileInput.current?.click()}
            className="hover:bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border"
          >
            <Paperclip className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('composer.formatting')}
            title={t('composer.formatting')}
            aria-pressed={formatBar}
            onClick={toggleFormatBar}
            className={cn(
              'hover:bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold',
              formatBar && 'bg-muted'
            )}
          >
            Aa
          </button>
          {chips.length === 0 && (
            <button
              type="button"
              aria-label={t('voice.record')}
              title={t('voice.record')}
              onClick={() => void startRecording()}
              disabled={sending}
              className="hover:bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border disabled:opacity-50"
            >
              <Mic className="size-4" aria-hidden />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          <MentionTextarea
            controlRef={input}
            className="min-w-0 flex-1"
            draft={draft}
            onDraftChange={changeDraft}
            onSubmit={() => void send()}
            broadcasts={offersBroadcasts(channel.kind)}
            ariaLabel={t('composer.placeholder')}
            placeholder={t('composer.placeholder')}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className="bg-primary text-primary-foreground hover:bg-primary-hover h-9 shrink-0 rounded-lg px-4 text-sm font-semibold disabled:opacity-50"
          >
            {t('composer.send')}
          </button>
        </div>
      )}
      {whatsapp}
    </div>
  );
}
