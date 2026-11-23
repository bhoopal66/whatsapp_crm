'use client';

// ============================================================
// Hand a person's work to a colleague (Settings → Members, migration
// 266). Opened right after someone is deactivated while they still hold
// something, from the roster for people who left earlier, and before a
// removal, which would leave the work with nobody. The database decides
// who may take what (`member_handover`); its refusal is shown as it is.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  HANDOVER_KINDS,
  handoverReceivers,
  parseWorkCounts,
  workTotal,
  type HandoverKind,
  type HandoverPerson,
  type WorkCounts,
} from '@/lib/auth/member-handover';

/** "12 chats, 3 open tasks": what a person holds, in the reader's language. */
export function useWorkText(): (counts: WorkCounts) => string {
  const t = useTranslations('Settings.members.handover');
  const locale = useLocale();
  return (counts) =>
    new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
      HANDOVER_KINDS.filter((k) => counts[k] > 0).map((k) =>
        t(`kinds.${k}`, { count: counts[k] })
      )
    );
}

export function MemberHandoverDialog({
  from,
  people,
  onClose,
  onMoved,
}: {
  /** Whose work it is; null closes the dialog. */
  from: HandoverPerson | null;
  /** The roster, to choose the receiver from. */
  people: readonly HandoverPerson[];
  onClose: () => void;
  onMoved: () => void;
}) {
  return (
    <Dialog open={from !== null} onOpenChange={(open) => !open && onClose()}>
      {from && (
        <HandoverForm
          key={from.user_id}
          from={from}
          people={people}
          onClose={onClose}
          onMoved={onMoved}
        />
      )}
    </Dialog>
  );
}

function HandoverForm({
  from,
  people,
  onClose,
  onMoved,
}: {
  from: HandoverPerson;
  people: readonly HandoverPerson[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const t = useTranslations('Settings.members.handover');
  const workText = useWorkText();
  const [counts, setCounts] = useState<WorkCounts | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<HandoverKind>>(new Set());
  const [to, setTo] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = `/api/account/members/${from.user_id}/handover`;
  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { counts?: unknown };
      setCounts(parseWorkCounts(body.counts));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);

  const receivers = handoverReceivers(people, from.user_id);
  const held = counts
    ? HANDOVER_KINDS.filter((k) => counts[k] > 0)
    : ([] as HandoverKind[]);
  const chosen = held.filter((k) => !left.has(k));
  const receiver = receivers.find((p) => p.user_id === to);

  const submit = async () => {
    if (!receiver || chosen.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: receiver.user_id, what: chosen }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        moved?: unknown;
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? t('failed'));
        return;
      }
      const moved = parseWorkCounts(body.moved);
      toast.success(
        workTotal(moved) > 0
          ? t('done', { what: workText(moved), name: receiver.name })
          : t('nothing', { name: from.name })
      );
      onMoved();
      onClose();
    } catch {
      // No answer: pressing again moves nothing twice (266).
      setError(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="bg-popover border-border sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="text-popover-foreground">
          {t('title', { name: from.name })}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {t('description')}
        </DialogDescription>
      </DialogHeader>

      {loadFailed && !counts ? (
        <div role="alert" className="space-y-3 text-sm">
          <p>{t('loadFailed', { name: from.name })}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoadFailed(false);
              void load();
            }}
          >
            <RotateCcw aria-hidden />
            {t('retry')}
          </Button>
        </div>
      ) : !counts ? (
        <div className="space-y-2" aria-busy>
          <div className="bg-muted h-4 w-40 animate-pulse rounded" />
          <div className="bg-muted h-4 w-32 animate-pulse rounded" />
        </div>
      ) : held.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('nothing', { name: from.name })}
        </p>
      ) : (
        <div className="space-y-4">
          <ul className="space-y-2">
            {held.map((kind) => (
              <li key={kind} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`handover-${kind}`}
                  checked={!left.has(kind)}
                  disabled={busy}
                  onCheckedChange={(on) =>
                    setLeft((prev) => {
                      const next = new Set(prev);
                      if (on) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                />
                <Label htmlFor={`handover-${kind}`} className="font-normal">
                  {t(`kinds.${kind}`, { count: counts[kind] })}
                </Label>
              </li>
            ))}
          </ul>
          <div className="space-y-2">
            <Label htmlFor="handover-to">{t('to')}</Label>
            {receivers.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noPeople')}</p>
            ) : (
              <Select
                value={to}
                onValueChange={(v) => setTo(v ?? '')}
                disabled={busy}
              >
                <SelectTrigger id="handover-to" className="w-full">
                  <SelectValue>
                    {receiver?.name ?? t('toPlaceholder')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {receivers.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
      )}

      <DialogFooter className="bg-popover border-border">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t('later')}
        </Button>
        {held.length > 0 && (
          <Button
            onClick={() => void submit()}
            disabled={!receiver || chosen.length === 0 || busy}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy ? t('submitting') : t('submit')}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
