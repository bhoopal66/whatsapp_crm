'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Lock, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import type { SharedCard } from '@/lib/chat';
import { sharedCardView } from '@/lib/chat/share';
import { inboxBasePath } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

/**
 * A conversation shared into chat: a read-only snapshot with live fields
 * for a viewer who may open it; anyone else sees only that it is there.
 */
export function SharedConversationCard({ card }: { card: SharedCard }) {
  const t = useTranslations('Chat.card');
  // A team leader's inbox list is the team view, as in the composer.
  const { accountRole } = useAuth();
  const view = sharedCardView(card);

  if (!view.access)
    return (
      <div className="bg-card mt-1.5 max-w-[730px] overflow-hidden rounded-xl border">
        <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <MessageCircle className="text-primary size-3.5" aria-hidden />
          <span className="text-muted-foreground flex-1">{t('header')}</span>
        </div>
        <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t('noAccess')}
        </p>
      </div>
    );

  const { conversationId, tag } = view;
  const name = view.name ?? t('customer');

  async function createTask() {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: t('taskTitle', { name }),
        conversationId,
      }),
    }).catch(() => null);
    if (res?.ok) toast.success(t('taskCreated'));
    else toast.error(t('taskFailed'));
  }

  return (
    <div className="bg-card mt-1.5 max-w-[730px] overflow-hidden rounded-xl border">
      <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <MessageCircle className="text-primary size-3.5" aria-hidden />
        <span className="text-muted-foreground flex-1">{t('header')}</span>
        {tag && (
          <span className="bg-warning-soft text-warning rounded-full px-2 py-0.5 font-semibold">
            {tag.name}
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-bold">{name}</span>
          {view.owner && (
            <span className="text-muted-foreground shrink-0 text-xs">
              {t('owner', { name: view.owner })}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{view.details}</p>
        <div className="space-y-1.5">
          {view.lastMessages.map((m, i) => {
            const customer = m.senderType === 'customer';
            return (
              <div
                key={i}
                className={cn(
                  'flex',
                  customer ? 'justify-start' : 'justify-end'
                )}
              >
                <p
                  className={cn(
                    'max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap',
                    customer ? 'bg-muted' : 'bg-success-soft'
                  )}
                >
                  {m.contentText ?? '…'}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-2 border-t px-3 py-2">
        <Link
          href={`${inboxBasePath(accountRole)}?c=${conversationId}`}
          className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-md px-3 py-1.5 text-xs font-semibold"
        >
          {t('open')}
        </Link>
        <button
          type="button"
          onClick={createTask}
          className="hover:bg-muted rounded-md border px-3 py-1.5 text-xs font-semibold"
        >
          {t('createTask')}
        </button>
      </div>
    </div>
  );
}
