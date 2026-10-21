'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Bookmark,
  BookmarkMinus,
  Copy,
  History,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  deleteMessageAndFiles,
  editMessage,
  messageEdits,
  type ChatMessage,
  type MessageEdit,
} from '@/lib/chat';
import { deserializeBody } from '@/lib/chat/composer';
import { editSubmission } from '@/lib/chat/composer-input';
import {
  applyLocalPatch,
  canViewEditHistory,
  editHistoryRows,
  localPatch,
  messageActions,
  plainText,
  QUICK_REACTIONS,
  type LocalPatch,
} from '@/lib/chat/message-actions';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { useMessageMarks } from './message-marks';
import { MentionTextarea } from './mention-textarea';

/** What every row of one view shares for messageActions(). */
export interface RowActionContext {
  userId: string | null;
  /** Workspace owner or admin (may delete anyone's message). */
  workspaceAdmin: boolean;
  /** The viewer may write here (useWriteBlock() === null). */
  canWrite: boolean;
  /** The view can open a thread. */
  threads: boolean;
  /** @channel / @here in the inline editor. */
  broadcasts: boolean;
}

/**
 * Edit and delete with the change shown at once (applyLocalPatch) until
 * the realtime echo replaces it; a refused change is taken back.
 */
export function useMessageEdits(message: ChatMessage) {
  const { sb, fail } = useChatWorkspaceContext();
  const [patch, setPatch] = useState<LocalPatch | null>(null);
  const [editing, setEditing] = useState(false);
  const run = async (p: LocalPatch, call: () => Promise<unknown>) => {
    setPatch(p);
    try {
      await call();
    } catch (err) {
      setPatch((cur) => (cur === p ? null : cur));
      fail(err);
    }
  };
  const now = () => new Date().toISOString();
  return {
    shown: applyLocalPatch(message, patch),
    editing,
    setEditing,
    save: (body: string) => {
      setEditing(false);
      // Patched against the server's version, never the shown one.
      void run(localPatch(message, { body, editedAt: now() }), () =>
        editMessage(sb, { messageId: message.id, body })
      );
    },
    remove: () =>
      void run(localPatch(message, { deletedAt: now() }), () =>
        deleteMessageAndFiles(message.id)
      ),
  };
}

/** The inline editor of one's own message: Enter or Save saves, Esc or Cancel cancels. */
export function MessageEditor({
  message,
  broadcasts,
  onSave,
  onCancel,
}: {
  message: ChatMessage;
  broadcasts: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Chat');
  const { peopleById } = useChatWorkspaceContext();
  const [draft, setDraft] = useState(() =>
    deserializeBody(message.body, peopleById)
  );
  const save = () => {
    const s = editSubmission(
      message.body,
      draft,
      message.attachments.map((a) => a.name)
    );
    if (s.kind === 'unchanged') onCancel();
    else if (s.kind === 'save') onSave(s.body);
    else if (s.reason === 'bodyLength') toast.error(t('errors.bodyLength'));
  };
  return (
    <div className="mt-1 rounded-lg border p-2">
      <MentionTextarea
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={save}
        onCancel={onCancel}
        broadcasts={broadcasts}
        ariaLabel={t('actions.editLabel')}
        autoFocus
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">
          {t('actions.editHint')}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('actions.editCancel')}
        </Button>
        <Button type="button" size="sm" onClick={save}>
          {t('actions.editSave')}
        </Button>
      </div>
    </div>
  );
}

const ICON_BUTTON =
  'hover:bg-muted flex size-7 items-center justify-center rounded-md text-sm';

/**
 * A message's earlier versions (internal_message_edits, 087), read once
 * on open. RLS hands them only to a workspace owner/admin on a channel
 * they read directly, so anyone else would see the empty list.
 */
function EditHistoryList({ messageId }: { messageId: string }) {
  const t = useTranslations('Chat');
  const format = useFormatter();
  const { sb, people } = useChatWorkspaceContext();
  const [edits, setEdits] = useState<MessageEdit[] | 'failed' | null>(null);
  useEffect(() => {
    let cancelled = false;
    messageEdits(sb, messageId).then(
      (list) => {
        if (!cancelled) setEdits(list);
      },
      () => {
        if (!cancelled) setEdits('failed');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sb, messageId]);

  if (edits === null)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('history.loading')}
      </p>
    );
  if (edits === 'failed')
    return <p className="text-destructive text-sm">{t('history.failed')}</p>;
  const rows = editHistoryRows(edits, people, t('unknownPerson'));
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground text-sm">{t('history.empty')}</p>
    );
  return (
    <ol className="max-h-[60vh] space-y-3 overflow-y-auto">
      {rows.map((r) => (
        <li key={r.id} className="rounded-lg border p-3">
          <p className="text-muted-foreground text-xs">
            {t('history.changed', {
              name: r.editorName,
              time: format.dateTime(new Date(r.editedAt.replace(' ', 'T')), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">
            {r.body || t('history.blank')}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * The hover toolbar of a message row (the row needs `group relative`):
 * quick reactions, Reply in thread and a "⋯" menu with the rest. On a
 * touch screen only the "⋯" shows, always, and its menu has everything.
 * Exactly the actions messageActions() allows.
 */
export function MessageActions({
  message: m,
  ctx,
  onToggleReaction,
  onOpenThread,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  ctx: RowActionContext;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (rootId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('Chat');
  const { people, fail } = useChatWorkspaceContext();
  const marks = useMessageMarks();
  const [confirming, setConfirming] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const can = messageActions(m, ctx);
  const history = canViewEditHistory(m, ctx.workspaceAdmin);
  if (!Object.values(can).some(Boolean)) return null;
  const pinned = marks.pinned.has(m.id);
  const saved = marks.saved.has(m.id);
  const mine = (emoji: string) =>
    !!ctx.userId &&
    m.reactions.some(
      (r) => r.emoji === emoji && r.userIds.includes(ctx.userId as string)
    );
  const thread = () => onOpenThread?.(m.id);
  const copy = () =>
    navigator.clipboard
      .writeText(plainText(m.body, people, t('unknownPerson')))
      .then(() => toast.success(t('actions.copied')), fail);

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('actions.toolbar')}
        className="bg-popover absolute -top-3 right-4 z-10 flex items-center gap-0.5 rounded-lg border p-0.5 opacity-0 shadow-sm group-hover:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:top-1 pointer-coarse:border-0 pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none"
      >
        {can.react &&
          QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-pressed={mine(emoji)}
              aria-label={t('timeline.react', { emoji })}
              onClick={() => onToggleReaction(m.id, emoji)}
              className={cn(
                ICON_BUTTON,
                'pointer-coarse:hidden',
                mine(emoji) && 'bg-success-soft'
              )}
            >
              {emoji}
            </button>
          ))}
        {can.thread && (
          <button
            type="button"
            aria-label={t('actions.replyInThread')}
            title={t('actions.replyInThread')}
            onClick={thread}
            className={cn(ICON_BUTTON, 'pointer-coarse:hidden')}
          >
            <MessagesSquare className="size-4" aria-hidden />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('actions.more')}
            title={t('actions.more')}
            className={ICON_BUTTON}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {can.react && (
              <div className="flex gap-0.5 pb-1">
                {QUICK_REACTIONS.map((emoji) => (
                  <DropdownMenuItem
                    key={emoji}
                    aria-label={t('timeline.react', { emoji })}
                    onClick={() => onToggleReaction(m.id, emoji)}
                    className="justify-center px-1.5 text-base"
                  >
                    {emoji}
                  </DropdownMenuItem>
                ))}
              </div>
            )}
            {can.thread && (
              <DropdownMenuItem onClick={thread}>
                <MessagesSquare aria-hidden />
                {t('actions.replyInThread')}
              </DropdownMenuItem>
            )}
            {can.edit && (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil aria-hidden />
                {t('actions.edit')}
              </DropdownMenuItem>
            )}
            {can.pin && (
              <DropdownMenuItem
                onClick={() => void marks.setPinned(m.id, !pinned)}
              >
                {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                {t(pinned ? 'actions.unpin' : 'actions.pin')}
              </DropdownMenuItem>
            )}
            {can.save && (
              <DropdownMenuItem
                onClick={() => void marks.setSaved(m.id, !saved)}
              >
                {saved ? (
                  <BookmarkMinus aria-hidden />
                ) : (
                  <Bookmark aria-hidden />
                )}
                {t(saved ? 'actions.unsave' : 'actions.save')}
              </DropdownMenuItem>
            )}
            {can.copy && (
              <DropdownMenuItem onClick={copy}>
                <Copy aria-hidden />
                {t('actions.copy')}
              </DropdownMenuItem>
            )}
            {history && (
              <DropdownMenuItem onClick={() => setShowHistory(true)}>
                <History aria-hidden />
                {t('actions.history')}
              </DropdownMenuItem>
            )}
            {can.delete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 aria-hidden />
                  {t('actions.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('history.title')}</DialogTitle>
            <DialogDescription>{t('history.description')}</DialogDescription>
          </DialogHeader>
          {showHistory && <EditHistoryList messageId={m.id} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('actions.deleteTitle')}
        description={t('actions.deleteBody')}
        cancelLabel={t('actions.editCancel')}
        confirmLabel={t('actions.deleteConfirm')}
        destructive
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
      />
    </>
  );
}
