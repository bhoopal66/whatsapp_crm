'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import type { SharedCard } from '@/lib/chat';
import { cn } from '@/lib/utils';

/** A conversation shared into chat: a read-only snapshot, live fields when the viewer may open it. */
export function SharedConversationCard({ card }: { card: SharedCard }) {
  const t = useTranslations('Chat.card');
  const s = card.snapshot;
  const name = s.contactName ?? t('customer');
  const tag = card.chatTag ?? null;

  async function createTask() {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: t('taskTitle', { name }),
        conversationId: card.conversationId,
      }),
    }).catch(() => null);
    if (res?.ok) toast.success(t('taskCreated'));
    else toast.error(t('taskFailed'));
  }

  return (
    <div className="bg-card mt-1.5 max-w-[730px] overflow-hidden rounded-xl border">
      <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <MessageCircle className="size-3.5 text-[#0E7C5A]" aria-hidden />
        <span className="text-muted-foreground flex-1">{t('header')}</span>
        {tag && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800 [[data-mode=dark]_&]:bg-amber-500/20 [[data-mode=dark]_&]:text-amber-200">
            {tag.name}
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-bold">{name}</span>
          {s.owner && (
            <span className="text-muted-foreground shrink-0 text-xs">
              {t('owner', { name: s.owner })}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {[s.phone, s.company].filter(Boolean).join(' · ')}
        </p>
        <div className="space-y-1.5">
          {s.lastMessages.slice(-2).map((m, i) => {
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
                    customer
                      ? 'bg-muted'
                      : 'bg-emerald-50 [[data-mode=dark]_&]:bg-emerald-500/15'
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
        {card.canOpen && (
          <Link
            href={`/inbox?c=${card.conversationId}`}
            className="rounded-md bg-[#0E7C5A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0b6a4d]"
          >
            {t('open')}
          </Link>
        )}
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
