'use client';

// "Share with bank" (migration 133): pick a bank, then one of its
// coordinators, and share this chat with them; the chat's open shares
// are listed with Revoke. The rules live in SQL
// (share_conversation_with_coordinator / revoke_conversation_share);
// this only offers the choice. The bank starts selected when the chat's
// sub-tag names one (`bankFromSubTag`); a successful share closes the
// dialog with a toast.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Handshake, Loader2, X } from 'lucide-react';
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
import { useAuth } from '@/hooks/use-auth';
import { REFERENCE_CACHE_TTL_MS, cachedQuery } from '@/lib/client-cache';
import { bankFromSubTag } from '@/lib/coordinators/bank-from-sub-tag';
import {
  canShareWithCoordinator,
  coordinatorChoices,
  type ConversationShareRow,
  type CoordinatorRow,
} from '@/lib/coordinators/ui';
import { cn } from '@/lib/utils';

interface BankOption {
  code: string;
  name: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function CoordinatorShareButton({
  conversationId,
  subTagName = null,
}: {
  conversationId: string;
  /** The chat's sub-tag name; a bank it names starts selected. */
  subTagName?: string | null;
}) {
  const t = useTranslations('Coordinators.share');
  const { accountRole } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canShareWithCoordinator(accountRole)) return null;
  return (
    <>
      {/* Icon and word; in a narrow thread (a phone) only the icon,
        which keeps its name through aria-label and the tooltip. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('buttonTitle')}
        aria-label={t('action')}
        className="border-wa-divider bg-wa-panel text-wa-text-secondary hover:bg-wa-row-hover inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors @md/thread:px-2.5"
      >
        <Handshake className="size-4 shrink-0" />
        <span className="hidden whitespace-nowrap @md/thread:inline">
          {t('action')}
        </span>
      </button>
      {open && (
        <ShareDialog
          conversationId={conversationId}
          subTagName={subTagName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareDialog({
  conversationId,
  subTagName,
  onClose,
}: {
  conversationId: string;
  subTagName: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Coordinators.share');
  const { user, accountId, accountRole } = useAuth();
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [coordinators, setCoordinators] = useState<CoordinatorRow[]>([]);
  const [shares, setShares] = useState<ConversationShareRow[] | null>(null);
  // A failed read is not "none"; a reload asks again.
  const [failed, setFailed] = useState({ banks: false, shares: false });
  const [reload, setReload] = useState(0);
  const [bank, setBank] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  // The bank the sub-tag picked, while it is still the selection.
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadShares = useCallback(async () => {
    try {
      const body = await getJson<{ shares: ConversationShareRow[] }>(
        `/api/conversations/${conversationId}/coordinator-shares`
      );
      setShares(body.shares);
      setFailed((f) => ({ ...f, shares: false }));
    } catch {
      setFailed((f) => ({ ...f, shares: true }));
    }
  }, [conversationId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        // Reference data, cached per account; the shares are not.
        const [b, c] = await Promise.all([
          cachedQuery(`case-banks:${accountId}`, REFERENCE_CACHE_TTL_MS, () =>
            getJson<{ banks: BankOption[] }>('/api/cases/config/banks').then(
              (r) => r.banks
            )
          ),
          // Admins get e-mail addresses in the list, others do not: the
          // key names the question so the two never share an entry.
          cachedQuery(
            `coordinators:${accountId}:${accountRole === 'owner' || accountRole === 'admin' ? 'emails' : 'names'}`,
            60_000,
            () =>
              getJson<{ coordinators: CoordinatorRow[] }>(
                '/api/coordinators'
              ).then((r) => r.coordinators)
          ),
        ]);
        if (cancelled) return;
        // Only banks someone coordinates can be shared under.
        const held = new Set(c.flatMap((x) => x.banks));
        const offered = b.filter((x) => held.has(x.code));
        setBanks(offered);
        setCoordinators(c);
        // Only a bank on offer, and never over the agent's own pick.
        const picked = bankFromSubTag(subTagName, offered);
        if (picked) {
          setBank((prev) => prev ?? picked);
          setSuggested((prev) => prev ?? picked);
        }
      } catch {
        if (!cancelled) setFailed((f) => ({ ...f, banks: true }));
      }
    })();
    void loadShares();
    return () => {
      cancelled = true;
    };
  }, [accountId, accountRole, loadShares, subTagName, reload]);

  function retry() {
    setFailed({ banks: false, shares: false });
    setReload((n) => n + 1);
  }
  const loadFailed = (
    <p
      className="text-destructive flex items-center gap-2 text-sm"
      role="alert"
    >
      {t('loadError')}
      <Button size="sm" variant="outline" onClick={retry}>
        {t('retry')}
      </Button>
    </p>
  );

  const choices = useMemo(
    () => coordinatorChoices(coordinators, bank, user?.id ?? null),
    [coordinators, bank, user?.id]
  );

  async function share() {
    if (!bank || !person || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/coordinator-shares`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coordinator_user_id: person,
            bank_code: bank,
          }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? t('shareError'));
        return;
      }
      toast.success(t('shared'));
      onClose();
    } catch {
      toast.error(t('shareError'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(shareId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/coordinator-shares/${shareId}`,
        { method: 'DELETE' }
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? t('revokeError'));
        return;
      }
      toast.success(t('revoked'));
      await loadShares();
    } catch {
      toast.error(t('revokeError'));
    } finally {
      setBusy(false);
    }
  }

  const chip = (selected: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
      selected
        ? 'bg-primary text-primary-foreground border-transparent'
        : 'bg-card text-foreground hover:bg-muted'
    );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">
              {t('bank')}
            </h3>
            {failed.banks ? (
              loadFailed
            ) : banks === null ? (
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            ) : banks.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noBanks')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {banks.map((b) => (
                  <button
                    key={b.code}
                    type="button"
                    aria-pressed={bank === b.code}
                    onClick={() => {
                      setBank(b.code);
                      setPerson(null);
                      setSuggested(null);
                    }}
                    className={chip(bank === b.code)}
                  >
                    {b.name} ({b.code})
                  </button>
                ))}
              </div>
            )}
            {suggested !== null && suggested === bank && (
              <p className="text-muted-foreground text-xs">{t('fromSubTag')}</p>
            )}
          </section>

          {bank && (
            <section className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-medium">
                {t('coordinator')}
              </h3>
              {choices.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('noCoordinators')}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {choices.map((c) => (
                    <button
                      key={c.user_id}
                      type="button"
                      aria-pressed={person === c.user_id}
                      onClick={() => setPerson(c.user_id)}
                      className={chip(person === c.user_id)}
                    >
                      {c.name || c.email || t('unnamed')}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">
              {t('openShares')}
            </h3>
            {failed.shares ? (
              loadFailed
            ) : shares === null ? (
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            ) : shares.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noShares')}</p>
            ) : (
              <ul className="divide-border divide-y rounded-md border">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {s.coordinator_name || t('unnamed')}
                      <span className="text-muted-foreground">
                        {' · '}
                        {s.bank_name} ({s.bank_code})
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revoke(s.id)}
                    >
                      <X className="size-3.5" />
                      {t('revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            disabled={!bank || !person || busy}
            onClick={() => void share()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
