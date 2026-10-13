'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Handshake, Hash, Loader2, Lock, Share2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import {
  listChannels,
  postMessage,
  shareCall,
  type ChannelWithMembership,
} from '@/lib/chat';
import {
  canShareCall,
  canShareToTeamChat,
  shareTargets,
} from '@/lib/chat/share';
import { chatErrorKey } from '@/lib/chat/view';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

/**
 * Inbox → "Share to team chat": posts a read-only card of this
 * conversation, with an optional comment, to a team or private channel.
 * Hidden for viewers and bank guests; the database re-checks the rest.
 */
export function ShareToChatButton({
  conversationId,
}: {
  conversationId: string;
}) {
  const t = useTranslations('Chat');
  const { accountRole } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canShareToTeamChat(accountRole)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('share.action')}
        aria-label={t('share.action')}
        className="text-wa-text-secondary hover:bg-wa-row-hover flex size-9 shrink-0 items-center justify-center rounded-full"
      >
        <Share2 className="size-4" />
      </button>
      {open && (
        <ShareDialog
          title={t('share.title')}
          description={t('share.description')}
          defaultBody={t('share.defaultBody')}
          submit={(sb, channelId, body) =>
            postMessage(sb, {
              channelId,
              body,
              shareConversationId: conversationId,
            })
          }
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * "Share to chat" on a call (103): posts a card of the call, with an
 * optional comment, to a team or private channel or a deal room's Team
 * notes. Never to the customer, the WhatsApp chat or a deal room's group.
 * Hidden for viewers, bank guests and an erased call; the database
 * re-checks the rest (the sharer must see the call, no bank guest).
 */
export function ShareCallButton({
  callId,
  recordingState,
}: {
  callId: string;
  recordingState: string | null | undefined;
}) {
  const t = useTranslations('Chat');
  const { accountRole } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canShareCall(accountRole, recordingState)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('share.callAction')}
        aria-label={t('share.callAction')}
        className="text-muted-foreground hover:bg-muted flex size-8 shrink-0 items-center justify-center rounded-full"
      >
        <Share2 className="size-4" />
      </button>
      {open && (
        <ShareDialog
          dealRooms
          title={t('share.callTitle')}
          description={t('share.callDescription')}
          defaultBody={t('share.callDefaultBody')}
          submit={(sb, channelId, body) =>
            shareCall(sb, { channelId, callId, body })
          }
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The channel picker both shares use. */
function ShareDialog({
  title,
  description,
  defaultBody,
  dealRooms = false,
  submit,
  onClose,
}: {
  title: string;
  description: string;
  /** Posted when the comment is blank; it must carry no customer detail. */
  defaultBody: string;
  dealRooms?: boolean;
  submit: (
    sb: ReturnType<typeof createClient>,
    channelId: string,
    body: string
  ) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useTranslations('Chat');
  const router = useRouter();
  const { accountId, user } = useAuth();
  const sb = useMemo(() => createClient(), []);
  const [channels, setChannels] = useState<ChannelWithMembership[] | null>(
    null
  );
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!accountId || !user?.id) return;
    let off = false;
    listChannels(sb, accountId, user.id)
      .then((list) => !off && setChannels(list))
      .catch((err) => {
        if (off) return;
        setChannels([]);
        toast.error(t(`errors.${chatErrorKey(err)}`));
      });
    return () => {
      off = true;
    };
  }, [sb, accountId, user?.id, t]);

  const targets = useMemo(
    () => shareTargets(channels ?? [], query, { dealRooms }),
    [channels, query, dealRooms]
  );
  const target = targets.find((c) => c.id === picked) ?? null;

  const share = async () => {
    if (!target || sending) return;
    setSending(true);
    try {
      await submit(sb, target.id, comment.trim() || defaultBody);
      toast.success(t('share.done', { name: target.name }), {
        action: {
          label: t('share.open'),
          onClick: () => router.push(`/chat/${target.id}`),
        },
      });
      onClose();
    } catch (err) {
      toast.error(t(`errors.${chatErrorKey(err)}`));
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('share.searchPlaceholder')}
          aria-label={t('share.searchPlaceholder')}
        />
        <div
          role="listbox"
          aria-label={t('share.channels')}
          className="max-h-56 min-h-24 overflow-y-auto rounded-md border p-1"
        >
          {channels === null ? (
            <p className="text-muted-foreground flex items-center gap-2 p-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('share.loading')}
            </p>
          ) : targets.length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">
              {t('share.none')}
            </p>
          ) : (
            targets.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={c.id === picked}
                onClick={() => setPicked(c.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                  c.id === picked
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'hover:bg-muted'
                )}
              >
                {c.kind === 'deal_room' ? (
                  <Handshake className="size-3.5 shrink-0" aria-hidden />
                ) : c.kind === 'private' ? (
                  <Lock className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <Hash className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {!c.joined && (
                  <span className="text-muted-foreground text-xs">
                    {t('share.joins')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t('share.commentPlaceholder')}
          aria-label={t('share.commentLabel')}
          rows={3}
          maxLength={8000}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>
            {t('share.cancel')}
          </Button>
          <Button onClick={share} disabled={!target || sending}>
            {sending && <Loader2 className="size-4 animate-spin" />}
            {t('share.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
