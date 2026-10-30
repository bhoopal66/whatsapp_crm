'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  Hash,
  Info,
  Loader2,
  Lock,
  MessageCircle,
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
import { Input } from '@/components/ui/input';
import {
  channelsWithGuests,
  forwardMessage,
  type ChatMessage,
} from '@/lib/chat';
import {
  FORWARD_MAX_TARGETS,
  forwardPreview,
  forwardTargets,
  toggleForwardTarget,
} from '@/lib/chat/forward';
import { plainText } from '@/lib/chat/message-actions';
import { chatErrorKey } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

/**
 * Forwards a message (text, files, voice note) to up to five other
 * channels or DMs of the workspace, one chat_forward_message per target.
 * The server copies the body with mentions as plain names and never a
 * shared customer or call card; `hasCard` only says so up front.
 */
export function ForwardDialog({
  message: m,
  hasCard,
  onClose,
}: {
  message: ChatMessage;
  hasCard: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('Chat');
  const { sb, accountId, userId, channels, people, peopleById } =
    useChatWorkspaceContext();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [withGuests, setWithGuests] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const all = useMemo(
    () =>
      forwardTargets(channels ?? [], {
        selfId: userId ?? '',
        peopleById,
        unknown: t('unknownPerson'),
        exclude: m.channelId,
      }),
    [channels, userId, peopleById, t, m.channelId]
  );
  const shown = useMemo(
    () =>
      forwardTargets(channels ?? [], {
        selfId: userId ?? '',
        peopleById,
        query,
        unknown: t('unknownPerson'),
        exclude: m.channelId,
      }),
    [channels, userId, peopleById, query, t, m.channelId]
  );

  // A failed lookup only means the warning is missing; the forward
  // itself is the database's decision.
  const guestKey = all
    .filter((c) => c.kind !== 'dm')
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    if (!guestKey) return;
    let off = false;
    channelsWithGuests(sb, guestKey.split(','))
      .then((s) => !off && setWithGuests(s))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [sb, guestKey]);

  const preview = forwardPreview(
    m,
    plainText(m.body, people, t('unknownPerson'))
  );
  const previewText =
    preview.kind === 'text'
      ? preview.text
      : preview.kind === 'voice'
        ? t('forward.previewVoice')
        : preview.kind === 'files'
          ? preview.name
          : t('forward.previewEmpty');
  const extraFiles =
    preview.kind === 'text'
      ? preview.files
      : preview.kind === 'files'
        ? preview.files - 1
        : 0;

  const full = picked.length >= FORWARD_MAX_TARGETS;

  const submit = async () => {
    if (!accountId || !picked.length || sending) return;
    setSending(true);
    let done = 0;
    // One at a time: each copies the files into its own channel's prefix.
    for (const id of picked) {
      try {
        await forwardMessage(sb, {
          accountId,
          messageId: m.id,
          targetChannelId: id,
          attachments: m.attachments,
        });
        done++;
      } catch (err) {
        const name = all.find((c) => c.id === id)?.name ?? '';
        toast.error(
          t('forward.failed', {
            name,
            reason: t(`errors.${chatErrorKey(err)}`),
          })
        );
      }
    }
    if (done) toast.success(t('forward.done', { count: done }));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('forward.title')}</DialogTitle>
          <DialogDescription>
            {t('forward.description', { max: FORWARD_MAX_TARGETS })}
          </DialogDescription>
        </DialogHeader>
        <div className="bg-card-2 rounded-md border px-3 py-2 text-sm">
          <p className="text-muted-foreground text-xs">
            {t('forward.preview')}
          </p>
          <p className="truncate">
            {previewText}
            {extraFiles > 0 && (
              <span className="text-muted-foreground">
                {' '}
                {t('forward.moreFiles', { count: extraFiles })}
              </span>
            )}
          </p>
        </div>
        {hasCard && (
          <p className="text-muted-foreground flex items-start gap-2 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t('forward.cardNote')}
          </p>
        )}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('forward.searchPlaceholder')}
          aria-label={t('forward.searchPlaceholder')}
        />
        <div
          role="listbox"
          aria-multiselectable
          aria-label={t('forward.targets')}
          className="max-h-64 min-h-24 overflow-y-auto rounded-md border p-1"
        >
          {channels === null ? (
            <p className="text-muted-foreground flex items-center gap-2 p-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('forward.loading')}
            </p>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">
              {t('forward.none')}
            </p>
          ) : (
            shown.map((c) => {
              const on = picked.includes(c.id);
              const Icon =
                c.kind === 'dm'
                  ? MessageCircle
                  : c.kind === 'private'
                    ? Lock
                    : Hash;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={sending || (!on && full)}
                  onClick={() => setPicked((p) => toggleForwardTarget(p, c.id))}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm disabled:opacity-50',
                    on
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'hover:bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      on && 'bg-primary border-primary text-primary-foreground'
                    )}
                    aria-hidden
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {withGuests.has(c.id) && (
                    <span className="bg-warning-soft text-warning flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-normal">
                      <AlertTriangle className="size-3" aria-hidden />
                      {t('forward.guests')}
                    </span>
                  )}
                  {!c.joined && (
                    <span className="text-muted-foreground shrink-0 text-xs font-normal">
                      {t('forward.joins')}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <DialogFooter className="items-center">
          <span className="text-muted-foreground mr-auto text-xs">
            {t('forward.selected', {
              count: picked.length,
              max: FORWARD_MAX_TARGETS,
            })}
          </span>
          <Button variant="outline" onClick={onClose} disabled={sending}>
            {t('forward.cancel')}
          </Button>
          <Button onClick={submit} disabled={!picked.length || sending}>
            {sending && <Loader2 className="size-4 animate-spin" />}
            {t('forward.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
