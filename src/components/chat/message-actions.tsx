'use client';

import { useEffect, useState, type RefObject } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Bookmark,
  BookmarkMinus,
  Copy,
  Forward,
  History,
  Link as LinkIcon,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  ShieldAlert,
  SmilePlus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { copyWithToast } from '@/components/context-menu/app-context-menu';
import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';
import {
  channelsWithGuests,
  deleteMessageAndFiles,
  editMessage,
  messageEdits,
  type ChatMessage,
  type MessageEdit,
} from '@/lib/chat';
import { chatHref } from '@/lib/chat/compose';
import { deserializeBody } from '@/lib/chat/composer';
import { editSubmission } from '@/lib/chat/composer-input';
import {
  needsGuestLookup,
  sensitiveDecision,
  stripMentionTokens,
  type SensitiveKind,
} from '@/lib/chat/composer-gating';
import { sensitiveKinds } from '@/lib/kb/sensitive';
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
import {
  MODERATION_REASON_MAX,
  moderationReasonValid,
  reasonLength,
} from '@/lib/chat/moderation';
import { cn } from '@/lib/utils';
import { useChatPermissions } from '@/hooks/use-chat-permissions';

import { useChatWorkspaceContext } from './chat-context';
import { ForwardDialog } from './forward-dialog';
import { useMessageMarks } from './message-marks';
import { MentionTextarea } from './mention-textarea';
import { useReplyTarget } from './reply-target';

/** What every row of one view shares for messageActions(). */
export interface RowActionContext {
  userId: string | null;
  /** Workspace owner or admin (may remove anyone's message, with a reason). */
  workspaceAdmin: boolean;
  /** A channel admin of this team/private channel (isChannelModerator). */
  channelAdmin: boolean;
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
    /** `reason` is required (160) when removing someone else's message. */
    remove: (reason?: string) =>
      void run(localPatch(message, { deletedAt: now() }), () =>
        deleteMessageAndFiles(message.id, undefined, reason)
      ),
  };
}

/**
 * The inline editor of one's own message: Enter or Save saves, Esc or
 * Cancel cancels. Save runs the composer's sensitive-data check (158):
 * 'warn' asks first, 'block' explains inline. UX only: the database
 * enforces 'block' on the edit as well.
 */
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
  const { sb, peopleById, channels } = useChatWorkspaceContext();
  const { permissions } = useChatPermissions();
  const [draft, setDraft] = useState(() =>
    deserializeBody(message.body, peopleById)
  );
  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState<SensitiveKind[] | null>(null);
  const [confirm, setConfirm] = useState<{
    body: string;
    kinds: SensitiveKind[];
    guests: boolean;
  } | null>(null);
  const kindNames = (kinds: readonly SensitiveKind[]) =>
    kinds.map((k) => t(`composer.sensitive.kind_${k}`)).join(', ');
  const kind = channels?.find((c) => c.id === message.channelId)?.kind;

  const save = async () => {
    if (checking) return;
    const s = editSubmission(
      message.body,
      draft,
      message.attachments.map((a) => a.name)
    );
    if (s.kind === 'unchanged') return onCancel();
    if (s.kind !== 'save') {
      if (s.reason === 'bodyLength') toast.error(t('errors.bodyLength'));
      return;
    }
    // Channel not loaded: nothing to judge the scope by, the server decides.
    if (!kind) return onSave(s.body);
    const kinds = sensitiveKinds(stripMentionTokens(s.body));
    setChecking(true);
    try {
      const hasGuest = needsGuestLookup(permissions.sensitive, kind, kinds)
        ? await channelsWithGuests(sb, [message.channelId]).then(
            (set) =>
              set.has(message.channelId) ||
              set.has(message.channelId.toLowerCase()),
            () => null
          )
        : null;
      const d = sensitiveDecision({
        kinds,
        guard: permissions.sensitive,
        kind,
        hasGuest,
      });
      if (d.action === 'block') setBlocked(d.kinds);
      else if (d.action === 'warn')
        setConfirm({ body: s.body, kinds: d.kinds, guests: d.guests });
      else onSave(s.body);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="mt-1 rounded-lg border p-2">
      <MentionTextarea
        draft={draft}
        onDraftChange={(next) => {
          setDraft(next);
          setBlocked(null);
        }}
        onSubmit={() => void save()}
        onCancel={onCancel}
        broadcasts={broadcasts}
        ariaLabel={t('actions.editLabel')}
        autoFocus
      />
      {blocked && (
        <p role="alert" className="text-destructive mt-1.5 text-xs">
          {t('actions.editSensitiveBlocked', { kinds: kindNames(blocked) })}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">
          {t('actions.editHint')}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('actions.editCancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={checking}
          onClick={() => void save()}
        >
          {t('actions.editSave')}
        </Button>
      </div>
      {confirm && (
        <Dialog open onOpenChange={(next) => !next && setConfirm(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('composer.sensitive.warnTitle')}</DialogTitle>
              <DialogDescription>
                {t('composer.sensitive.warnBody', {
                  kinds: kindNames(confirm.kinds),
                })}
                {confirm.guests && ` ${t('composer.sensitive.warnGuests')}`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                {t('composer.sensitive.edit')}
              </Button>
              <Button
                onClick={() => {
                  const body = confirm.body;
                  setConfirm(null);
                  onSave(body);
                }}
              >
                {t('actions.editSaveAnyway')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Removing someone else's message (160): the database requires a
 * reason of 5–500 characters and logs it, so Remove stays disabled
 * until the reason fits.
 */
function RemoveMessageDialog({
  open,
  onOpenChange,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (reason: string) => void;
}) {
  const t = useTranslations('Chat');
  const [reason, setReason] = useState('');
  const valid = moderationReasonValid(reason);
  const close = (next: boolean) => {
    if (!next) setReason('');
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('moderation.removeTitle')}</DialogTitle>
          <DialogDescription>{t('moderation.removeBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label htmlFor="chat-remove-reason" className="text-sm font-medium">
            {t('moderation.reasonLabel')}
          </label>
          <Textarea
            id="chat-remove-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('moderation.reasonPlaceholder')}
            rows={3}
            autoFocus
          />
          <p
            className={cn(
              'text-xs',
              reasonLength(reason) > MODERATION_REASON_MAX
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {t('moderation.reasonCount', {
              count: reasonLength(reason),
              max: MODERATION_REASON_MAX,
            })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            {t('actions.editCancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!valid}
            onClick={() => {
              const r = reason.trim();
              close(false);
              onRemove(r);
            }}
          >
            {t('moderation.removeConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NO_ROW: RefObject<HTMLDivElement | null> = { current: null };

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
 * quick reactions, Reply (a quote, where the view has a composer to
 * quote into), Reply in thread and a "⋯" menu with the rest. On a
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
  rowRef,
  hasCard = false,
}: {
  message: ChatMessage;
  ctx: RowActionContext;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (rootId: string) => void;
  onEdit: () => void;
  /** With a reason when it removes someone else's message (moderation). */
  onDelete: (reason?: string) => void;
  /** The message row: right-click there offers the same actions. */
  rowRef?: RefObject<HTMLDivElement | null>;
  /** The message carries a shared customer or call card (not forwarded). */
  hasCard?: boolean;
}) {
  const t = useTranslations('Chat');
  const tMenu = useTranslations('ContextMenu');
  const { people, channels, fail } = useChatWorkspaceContext();
  const marks = useMessageMarks();
  const [confirming, setConfirming] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const { permissions } = useChatPermissions();
  // The edit/delete windows (157) are judged at the moment the toolbar
  // is reached (hover, focus, menu open) and right-click: no timer, and
  // the RPC refuses a closed window anyway.
  const [now, setNow] = useState(() => Date.now());
  const refreshNow = () => setNow(Date.now());
  const can = messageActions(m, { ...ctx, permissions, now });
  // The toolbar shows on hovering the row, so the row's hover refreshes it.
  useEffect(() => {
    const row = rowRef?.current;
    if (!row) return;
    const onEnter = () => setNow(Date.now());
    row.addEventListener('pointerenter', onEnter);
    return () => row.removeEventListener('pointerenter', onEnter);
  }, [rowRef]);
  const replyTarget = useReplyTarget();
  // Only inside a composer's ReplyTargetProvider (channel view, thread panel).
  const quotes = can.quote && replyTarget.available;
  const quote = () => replyTarget.set(m);
  const history = canViewEditHistory(m, ctx.workspaceAdmin);
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
  // A deal room's Team notes redirect to the room page, which drops
  // ?message=, so a link there would not lead to the message.
  const linkable =
    channels?.find((c) => c.id === m.channelId)?.kind !== 'deal_room';

  // Registered before the early return below: hooks run on every render.
  useContextMenuItems(rowRef ?? NO_ROW, (): ContextMenuEntry[] => {
    // Built at right-click time, so the windows are judged then.
    const can = messageActions(m, { ...ctx, permissions, now: Date.now() });
    const quotes = can.quote && replyTarget.available;
    return !Object.values(can).some(Boolean)
      ? []
      : [
          ...(quotes
            ? [
                {
                  id: 'quote',
                  label: t('actions.quoteReply'),
                  icon: Reply,
                  onSelect: quote,
                },
              ]
            : []),
          ...(can.thread
            ? [
                {
                  id: 'thread',
                  label: t('actions.replyInThread'),
                  icon: MessagesSquare,
                  onSelect: thread,
                },
              ]
            : []),
          ...(can.react
            ? [
                {
                  id: 'react',
                  label: tMenu('chat.react'),
                  icon: SmilePlus,
                  items: QUICK_REACTIONS.map((emoji) => ({
                    id: `react-${emoji}`,
                    label: emoji,
                    onSelect: () => onToggleReaction(m.id, emoji),
                  })),
                },
              ]
            : []),
          { type: 'separator' },
          ...(can.copy
            ? [
                {
                  id: 'copy',
                  label: t('actions.copy'),
                  icon: Copy,
                  onSelect: () => void copy(),
                },
              ]
            : []),
          ...(can.copy && linkable
            ? [
                {
                  id: 'copyLink',
                  label: tMenu('chat.copyMessageLink'),
                  icon: LinkIcon,
                  onSelect: () =>
                    void copyWithToast(
                      window.location.origin +
                        chatHref(m.channelId, {
                          thread: m.threadRootId,
                          message: m.id,
                        }),
                      { copied: tMenu('copied'), failed: tMenu('copyFailed') }
                    ),
                },
              ]
            : []),
          ...(can.forward
            ? [
                {
                  id: 'forward',
                  label: t('actions.forward'),
                  icon: Forward,
                  onSelect: () => setForwarding(true),
                },
              ]
            : []),
          { type: 'separator' },
          ...(can.pin
            ? [
                {
                  id: 'pin',
                  label: t(pinned ? 'actions.unpin' : 'actions.pin'),
                  icon: pinned ? PinOff : Pin,
                  onSelect: () => void marks.setPinned(m.id, !pinned),
                },
              ]
            : []),
          ...(can.save
            ? [
                {
                  id: 'save',
                  label: t(saved ? 'actions.unsave' : 'actions.save'),
                  icon: saved ? BookmarkMinus : Bookmark,
                  onSelect: () => void marks.setSaved(m.id, !saved),
                },
              ]
            : []),
          ...(can.edit
            ? [
                {
                  id: 'edit',
                  label: t('actions.edit'),
                  icon: Pencil,
                  onSelect: onEdit,
                },
              ]
            : []),
          ...(history
            ? [
                {
                  id: 'history',
                  label: t('actions.history'),
                  icon: History,
                  onSelect: () => setShowHistory(true),
                },
              ]
            : []),
          { type: 'separator' },
          ...(can.delete
            ? [
                {
                  id: 'delete',
                  label: t('actions.delete'),
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => setConfirming(true),
                },
              ]
            : []),
          ...(can.moderate
            ? [
                {
                  id: 'moderate',
                  label: t('moderation.remove'),
                  icon: ShieldAlert,
                  destructive: true,
                  onSelect: () => setModerating(true),
                },
              ]
            : []),
        ];
  });

  if (!Object.values(can).some(Boolean)) return null;

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('actions.toolbar')}
        onFocus={refreshNow}
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
        {quotes && (
          <button
            type="button"
            aria-label={t('actions.quoteReply')}
            title={t('actions.quoteReply')}
            onClick={quote}
            className={cn(ICON_BUTTON, 'pointer-coarse:hidden')}
          >
            <Reply className="size-4" aria-hidden />
          </button>
        )}
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
        <DropdownMenu onOpenChange={(open) => open && refreshNow()}>
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
            {quotes && (
              <DropdownMenuItem onClick={quote}>
                <Reply aria-hidden />
                {t('actions.quoteReply')}
              </DropdownMenuItem>
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
            {can.forward && (
              <DropdownMenuItem onClick={() => setForwarding(true)}>
                <Forward aria-hidden />
                {t('actions.forward')}
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
            {can.moderate && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setModerating(true)}
                >
                  <ShieldAlert aria-hidden />
                  {t('moderation.remove')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {forwarding && (
        <ForwardDialog
          message={m}
          hasCard={hasCard}
          onClose={() => setForwarding(false)}
        />
      )}
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
      {can.moderate && (
        <RemoveMessageDialog
          open={moderating}
          onOpenChange={setModerating}
          onRemove={(reason) => onDelete(reason)}
        />
      )}
    </>
  );
}
