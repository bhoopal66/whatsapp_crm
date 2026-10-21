'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  FileText,
  Loader2,
  MessageCircle,
  Paperclip,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { postMessage, uploadChatFile, type SharedCard } from '@/lib/chat';
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
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { MentionTextarea } from './mention-textarea';
import { useWriteBlock } from './use-write-block';

export interface ComposerProps {
  channelId: string;
  /** Thread mode: replies to this root. */
  threadRootId?: string | null;
  /** The thread root's shared conversation, for the WhatsApp link. */
  sharedCard?: SharedCard | null;
  onPosted?: (messageId: string) => void;
}

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
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
        <MentionTextarea
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
      {whatsapp}
    </div>
  );
}
