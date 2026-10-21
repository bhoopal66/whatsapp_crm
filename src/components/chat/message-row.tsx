'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Sparkles } from 'lucide-react';

import {
  mentionSegments,
  signedFileUrl,
  type ChatAttachment,
  type ChatMessage,
  type ChatPerson,
  type SharedCallCard,
  type SharedCard,
} from '@/lib/chat';
import {
  avatarTint,
  boldSegments,
  formatBytes,
  formatClock,
  initialOf,
  roleLabelKey,
} from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import {
  MessageActions,
  MessageEditor,
  useMessageEdits,
  type RowActionContext,
} from './message-actions';
import { SharedCallCardBox } from './shared-call-card';
import { SharedConversationCard } from './shared-conversation-card';

const CHIP = 'rounded px-1 font-semibold bg-primary-soft text-primary';

export interface MessageRowProps {
  message: ChatMessage;
  grouped: boolean;
  card?: SharedCard;
  callCard?: SharedCallCard;
  /** The hover toolbar's context; no toolbar without it. */
  actions?: RowActionContext;
  onToggleReaction: (messageId: string, emoji: string) => void;
  /** Opens the thread panel (a later job). */
  onOpenThread?: (rootId: string) => void;
  /** Gives the row its anchor id (message-<id>); the main timeline only, so ids stay unique. */
  anchor?: boolean;
  /** The target of a jump, tinted for a moment. */
  highlighted?: boolean;
}

function AttachmentView({ a }: { a: ChatAttachment }) {
  const { sb } = useChatWorkspaceContext();
  const [url, setUrl] = useState<string | null>(null);
  const image = a.mime.startsWith('image/');
  useEffect(() => {
    if (!image) return;
    let off = false;
    signedFileUrl(sb, a.storagePath)
      .then((u) => !off && setUrl(u))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [sb, a.storagePath, image]);
  if (image)
    return url ? (
      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
      <img
        src={url}
        alt={a.name}
        className="max-h-48 max-w-64 rounded-lg border object-cover"
      />
    ) : (
      <div className="bg-muted size-32 animate-pulse rounded-lg" />
    );
  return (
    <button
      type="button"
      onClick={() =>
        signedFileUrl(sb, a.storagePath)
          .then((u) => window.open(u, '_blank', 'noopener'))
          .catch(() => {})
      }
      className="hover:bg-muted flex max-w-64 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm"
    >
      <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{a.name}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {formatBytes(a.bytes)}
      </span>
    </button>
  );
}

export function MessageRow({
  message,
  grouped,
  card,
  callCard,
  actions,
  onToggleReaction,
  onOpenThread,
  anchor = false,
  highlighted = false,
}: MessageRowProps) {
  const t = useTranslations('Chat');
  const tRole = useTranslations('Sidebar');
  const { peopleById, people, userId } = useChatWorkspaceContext();
  const edits = useMessageEdits(message);
  const rowRef = useRef<HTMLDivElement>(null);
  const m = edits.shown;
  const system = m.authorKind === 'system';
  const person: ChatPerson | undefined = m.authorId
    ? peopleById.get(m.authorId.toLowerCase())
    : undefined;
  const name = system
    ? t('timeline.system')
    : (person?.fullName ?? t('unknownPerson'));
  const roleKey = roleLabelKey(person?.role);
  const time = formatClock(m.createdAt);

  let body: React.ReactNode;
  if (m.deletedAt)
    body = (
      <p className="text-muted-foreground text-sm italic">
        {t('timeline.deleted')}
      </p>
    );
  else if (system)
    body = (
      <p className="text-sm whitespace-pre-wrap">
        {boldSegments(m.body).map((s, i) =>
          s.bold ? <strong key={i}>{s.text}</strong> : s.text
        )}
      </p>
    );
  else
    body = (
      <p className="text-sm break-words whitespace-pre-wrap">
        {mentionSegments(m.body, people).map((s, i) =>
          s.type === 'text' ? (
            s.text
          ) : s.type === 'mention' ? (
            <span key={i} className={CHIP}>
              @{s.name ?? t('unknownPerson')}
            </span>
          ) : (
            <span key={i} className={CHIP}>
              @{s.kind}
            </span>
          )
        )}
        {m.editedAt && (
          <span className="text-muted-foreground ml-1 text-xs">
            {t('timeline.edited')}
          </span>
        )}
      </p>
    );

  if (edits.editing && !m.deletedAt)
    body = (
      <MessageEditor
        message={m}
        broadcasts={actions?.broadcasts ?? false}
        onSave={edits.save}
        onCancel={() => edits.setEditing(false)}
      />
    );

  return (
    <div
      ref={rowRef}
      id={anchor ? `message-${m.id}` : undefined}
      data-message-id={m.id}
      className={cn(
        'group hover:bg-muted/40 relative flex gap-3 px-4 transition-colors',
        grouped ? 'py-0.5' : 'pt-3 pb-0.5',
        highlighted && 'bg-warning-soft hover:bg-warning-soft'
      )}
    >
      {actions && !edits.editing && (
        <MessageActions
          message={m}
          ctx={actions}
          onToggleReaction={onToggleReaction}
          onOpenThread={onOpenThread}
          onEdit={() => edits.setEditing(true)}
          onDelete={edits.remove}
          rowRef={rowRef}
        />
      )}
      <div className="w-9 shrink-0">
        {!grouped &&
          (system ? (
            <div className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
              <Sparkles className="size-4" aria-hidden />
            </div>
          ) : (
            <div
              className={cn(
                'flex size-9 items-center justify-center rounded-lg text-sm font-bold',
                avatarTint(m.authorId)
              )}
            >
              {initialOf(person?.fullName)}
            </div>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="text-sm">
            <span className="font-bold">{name}</span>
            {!system && roleKey && (
              <span className="text-muted-foreground"> · {tRole(roleKey)}</span>
            )}
            <span className="text-muted-foreground"> · {time}</span>
          </p>
        )}
        {body}
        {m.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} a={a} />
            ))}
          </div>
        )}
        {card && !m.deletedAt && <SharedConversationCard card={card} />}
        {callCard && !m.deletedAt && <SharedCallCardBox card={callCard} />}
        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => {
              const mine = !!userId && r.userIds.includes(userId);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  aria-pressed={mine}
                  aria-label={t('timeline.react', { emoji: r.emoji })}
                  onClick={() => onToggleReaction(m.id, r.emoji)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                    mine
                      ? 'border-primary/50 bg-primary-soft text-primary font-semibold'
                      : 'hover:bg-muted'
                  )}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {m.thread && m.thread.replyCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread?.(m.id)}
            className="mt-1 flex items-center gap-2 rounded-md py-0.5 text-xs"
          >
            <span className="flex -space-x-1">
              {m.thread.authorIds.slice(0, 3).map((id) => (
                <span
                  key={id}
                  className={cn(
                    'ring-background flex size-5 items-center justify-center rounded text-[10px] font-bold ring-2',
                    avatarTint(id)
                  )}
                >
                  {initialOf(peopleById.get(id.toLowerCase())?.fullName)}
                </span>
              ))}
            </span>
            <span className="text-primary font-bold">
              {t('timeline.replies', {
                count: m.thread.replyCount,
                time: m.thread.lastReplyAt
                  ? formatClock(m.thread.lastReplyAt)
                  : '',
              })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
