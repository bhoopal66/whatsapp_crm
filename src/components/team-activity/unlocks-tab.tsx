'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Check, Loader2, MessageSquare, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { useRuleName, useRuleSentence } from './blocks-tab';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DECISION_NOTE_MAX,
  orderUnlocks,
  type TeamBlock,
  type UnlockRequest,
  type UnlockStatus,
} from '@/lib/team-activity/team-blocks';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<UnlockStatus, string> = {
  pending: 'border-info/30 bg-info-soft text-info',
  approved: 'border-success/30 bg-success-soft text-success',
  denied: 'border-destructive/30 bg-destructive-soft text-destructive',
  used: 'border-border bg-card-2 text-muted-foreground',
  expired: 'border-border bg-card-2 text-muted-foreground',
};

export function UnlocksTab({
  unlocks,
  error,
  onRetry,
  blocksById,
  nameOf,
  deciding,
  onDecide,
}: {
  unlocks: UnlockRequest[] | null;
  error: boolean;
  onRetry: () => void;
  blocksById: ReadonlyMap<string, TeamBlock>;
  nameOf: (userId: string | null) => string;
  /** The request whose decision is on its way, if any. */
  deciding: string | null;
  onDecide: (id: string, approve: boolean, note: string | null) => void;
}) {
  const t = useTranslations('TeamActivity.unlocksTab');
  const format = useFormatter();
  const ruleName = useRuleName();
  const sentence = useRuleSentence();
  const [asking, setAsking] = useState<{
    request: UnlockRequest;
    approve: boolean;
  } | null>(null);
  const [note, setNote] = useState('');

  const { pending, decided } = useMemo(
    () => orderUnlocks(unlocks ?? []),
    [unlocks]
  );

  if (error) {
    return (
      <div className="border-destructive/30 bg-destructive-soft text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm">
        <span>{t('loadFailed')}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!unlocks) {
    return <div className="bg-card-2 h-40 w-full animate-pulse rounded-xl" />;
  }

  // The linked block words the rule with its figures; without it
  // (outside the page's range) the rule's short name stands in.
  const ruleText = (u: UnlockRequest) => {
    const b = u.blockId ? blocksById.get(u.blockId) : undefined;
    return b ? sentence(b.rule, b.detail) : ruleName(u.rule);
  };
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  const open = (request: UnlockRequest, approve: boolean) => {
    setNote('');
    setAsking({ request, approve });
  };

  const confirm = () => {
    if (!asking) return;
    const trimmed = note.trim();
    onDecide(asking.request.id, asking.approve, trimmed || null);
    setAsking(null);
  };

  const chatLink = (u: UnlockRequest) =>
    u.conversationId ? (
      <Link
        href={`/inbox?c=${encodeURIComponent(u.conversationId)}`}
        className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
      >
        <MessageSquare className="h-3.5 w-3.5" aria-hidden />
        {t('openChat')}
      </Link>
    ) : null;

  return (
    <div className="space-y-6">
      <section className="border-border bg-card rounded-xl border">
        <h2 className="text-foreground border-border border-b px-4 py-3 text-base font-semibold">
          {t('pendingTitle')}
        </h2>
        {pending.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {t('pendingEmpty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {pending.map((u) => (
              <li
                key={u.id}
                className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="text-foreground font-medium">
                      {nameOf(u.requesterId)}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {when(u.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-sm">{ruleText(u)}</p>
                  <p className="bg-card-2 text-foreground rounded-md px-2.5 py-1.5 text-sm break-words">
                    {t('reason', { reason: u.reason })}
                  </p>
                  {chatLink(u)}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={deciding !== null}
                    onClick={() => open(u, true)}
                  >
                    {deciding === u.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {t('approve')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={deciding !== null}
                    onClick={() => open(u, false)}
                  >
                    <X className="h-4 w-4" />
                    {t('deny')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border-border bg-card rounded-xl border">
        <h2 className="text-foreground border-border border-b px-4 py-3 text-base font-semibold">
          {t('decidedTitle')}
        </h2>
        {decided.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {t('decidedEmpty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {decided.map((u) => (
              <li key={u.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs font-medium',
                      STATUS_TONE[u.status]
                    )}
                  >
                    {t(`status.${u.status}`)}
                  </span>
                  <span className="text-foreground font-medium">
                    {nameOf(u.requesterId)}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {when(u.decidedAt ?? u.createdAt)}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">{ruleText(u)}</p>
                <p className="text-muted-foreground text-sm break-words">
                  {t('reason', { reason: u.reason })}
                </p>
                {u.decisionNote && (
                  <p className="text-muted-foreground text-sm break-words">
                    {t('note', { note: u.decisionNote })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={asking !== null}
        onOpenChange={(o) => {
          if (!o) setAsking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {asking?.approve ? t('approveTitle') : t('denyTitle')}
            </DialogTitle>
            <DialogDescription>
              {asking
                ? t(asking.approve ? 'approveDescription' : 'denyDescription', {
                    name: nameOf(asking.request.requesterId),
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="unlock-note">{t('noteLabel')}</Label>
            <Textarea
              id="unlock-note"
              value={note}
              maxLength={DECISION_NOTE_MAX}
              placeholder={t('notePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAsking(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant={asking?.approve ? 'default' : 'destructive'}
              onClick={confirm}
            >
              {asking?.approve ? t('approve') : t('deny')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
