'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  appendPage,
  canRevealFrom,
  charCount,
  FORGET_REASON_MAX,
  memoryListUrl,
  nextBefore,
  parseMemoryItems,
  type MemoryItemView,
} from '@/lib/memory/ui';
import { SEARCH_Q_MAX } from '@/lib/memory/search-request';

import { MemoryContent } from './memory-content';
import { MemoryForm } from './memory-form';

const PAGE = 20;
const COMPACT_SHOWN = 5;
const SEARCH_DEBOUNCE_MS = 300;

type State = 'loading' | 'ok' | 'error';
type Form = { correcting: MemoryItemView | null } | null;

/**
 * CRM memory for one case or one customer (019b): list, search, add,
 * correct, and (owner / admin) forget all. Vault tokens in the content
 * are revealable by a vault role (019c).
 */
export function MemoryPanel({
  apiBase,
  canWrite,
  canForget,
  compact = false,
}: {
  /** `/api/cases/<id>/memory` or `/api/contacts/<id>/memory`. */
  apiBase: string;
  canWrite: boolean;
  /** Owner / admin. Also gates the vault check: only they can reveal. */
  canForget: boolean;
  /** The customer page's card: the first five, then "Show all". */
  compact?: boolean;
}) {
  const t = useTranslations('Memory');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MemoryItemView[]>([]);
  const [state, setState] = useState<State>('loading');
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Form>(null);
  const [forgetting, setForgetting] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const [canReveal, setCanReveal] = useState(false);
  // Drops a response that a newer search or reload overtook.
  const seq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const mine = ++seq.current;
    (async () => {
      setState('loading');
      try {
        // The search text goes in the body, never the URL (access logs).
        const res = q
          ? await fetch(`${apiBase}/search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                q: q.slice(0, SEARCH_Q_MAX),
                limit: PAGE,
              }),
              cache: 'no-store',
            })
          : await fetch(memoryListUrl(apiBase, { limit: PAGE }), {
              cache: 'no-store',
            });
        const json: unknown = res.ok
          ? await res.json().catch(() => null)
          : null;
        if (mine !== seq.current) return;
        if (!res.ok) return setState('error');
        const page = parseMemoryItems(json);
        setItems(page);
        setMore(!q && page.length === PAGE);
        setState('ok');
      } catch {
        if (mine === seq.current) setState('error');
      }
    })();
  }, [apiBase, q, attempt]);

  // GET /api/vault is owner / admin only (403 for everyone else), the
  // same people as canForget, so nobody else asks.
  useEffect(() => {
    if (!canForget) return;
    let current = true;
    (async () => {
      try {
        const res = await fetch('/api/vault', { cache: 'no-store' });
        const json: unknown = res.ok
          ? await res.json().catch(() => null)
          : null;
        if (current) setCanReveal(res.ok && canRevealFrom(json));
      } catch {
        if (current) setCanReveal(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [canForget]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const loadMore = async () => {
    const before = nextBefore(items);
    if (!before) return setMore(false);
    const mine = seq.current;
    setPaging(true);
    try {
      const res = await fetch(memoryListUrl(apiBase, { before, limit: PAGE }), {
        cache: 'no-store',
      });
      const json: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (mine !== seq.current) return;
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const page = parseMemoryItems(json);
      setItems((shown) => appendPage(shown, page));
      setMore(page.length === PAGE);
    } catch {
      if (mine === seq.current) toast.error(t('loadFailed'));
    } finally {
      setPaging(false);
    }
  };

  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
      new Date(iso)
    );
  const who = (id: string | null) =>
    id ? (nameOf(id) ?? t('formerMember')) : t('system');

  const shown = expanded ? items : items.slice(0, COMPACT_SHOWN);
  const hidden = items.length - shown.length;
  const scopeKind = apiBase.startsWith('/api/contacts/') ? 'contact' : 'case';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            maxLength={SEARCH_Q_MAX}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            className="pl-8"
          />
        </div>
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('');
              setQ('');
            }}
          >
            <X className="size-4" aria-hidden />
            {t('clear')}
          </Button>
        )}
        {canWrite && !form && (
          <Button
            type="button"
            size="sm"
            onClick={() => setForm({ correcting: null })}
          >
            <Plus className="size-4" aria-hidden />
            {t('add')}
          </Button>
        )}
      </div>

      {form && (
        <MemoryForm
          key={form.correcting?.id ?? 'new'}
          apiBase={apiBase}
          correcting={form.correcting}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            reload();
          }}
        />
      )}

      {state === 'loading' ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('loading')}
        </p>
      ) : state === 'error' ? (
        <div className="flex flex-col items-center gap-2 py-6 text-sm">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {q ? t('noMatches') : t('empty')}
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {shown.map((item) => (
            <li key={item.id} className="space-y-1.5 py-3 text-sm first:pt-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {item.kind && (
                  <Badge variant="outline">{t(`kinds.${item.kind}`)}</Badge>
                )}
                {item.trust === 'verified' ? (
                  <Badge variant="secondary" title={t('verifiedHint')}>
                    {t('verified')}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="text-muted-foreground border-dashed"
                    title={t('untrustedHint')}
                  >
                    {t('untrusted')}
                  </Badge>
                )}
                <Importance
                  value={item.importance}
                  label={t('importance', { value: item.importance })}
                />
              </div>
              <MemoryContent content={item.content} canReveal={canReveal} />
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {item.createdAt && (
                  <span>
                    {t('byOn', {
                      who: who(item.createdBy),
                      when: when(item.createdAt),
                    })}
                  </span>
                )}
                {item.expiresAt && (
                  <span>{t('expires', { date: day(item.expiresAt) })}</span>
                )}
                {canWrite && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setForm({ correcting: item })}
                  >
                    {t('correct')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {state === 'ok' && (hidden > 0 || (expanded && more) || canForget) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {hidden > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(true)}
              >
                {t('showAll')}
              </Button>
            ) : (
              expanded &&
              more && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={paging}
                  onClick={() => void loadMore()}
                >
                  {paging && (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  )}
                  {t('loadMore')}
                </Button>
              )
            )}
            {compact && expanded && items.length > COMPACT_SHOWN && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(false)}
              >
                {t('showLess')}
              </Button>
            )}
          </div>
          {canForget && items.length > 0 && !q && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => setForgetting(true)}
            >
              <Trash2 className="size-4" aria-hidden />
              {t('forget.action')}
            </Button>
          )}
        </div>
      )}

      {forgetting && (
        <ForgetDialog
          apiBase={apiBase}
          scopeKind={scopeKind}
          onClose={() => setForgetting(false)}
          onDone={() => {
            setForgetting(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function Importance({ value, label }: { value: number; label: string }) {
  return (
    <span
      className="ml-auto inline-flex items-center gap-0.5"
      role="img"
      aria-label={label}
      title={label}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={
            n <= value
              ? 'bg-foreground/70 size-1.5 rounded-full'
              : 'bg-muted-foreground/25 size-1.5 rounded-full'
          }
        />
      ))}
    </span>
  );
}

/** Erase every memory of this case / customer, with a required reason. */
function ForgetDialog({
  apiBase,
  scopeKind,
  onClose,
  onDone,
}: {
  apiBase: string;
  scopeKind: 'case' | 'contact';
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('Memory');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const tooLong = charCount(reason) > FORGET_REASON_MAX;

  const erase = async () => {
    if (!reason.trim() || tooLong) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const json = (await res.json().catch(() => null)) as {
        erased?: unknown;
      } | null;
      if (!res.ok) {
        toast.error(t('forget.failed'));
        return;
      }
      toast.success(
        t('forget.done', {
          count: typeof json?.erased === 'number' ? json.erased : 0,
        })
      );
      onDone();
    } catch {
      toast.error(t('forget.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('forget.title')}</DialogTitle>
          <DialogDescription>
            {scopeKind === 'contact'
              ? t('forget.contactBody')
              : t('forget.caseBody')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="memory-forget-reason">{t('forget.reason')}</Label>
          <Textarea
            id="memory-forget-reason"
            value={reason}
            rows={2}
            placeholder={t('forget.reasonPlaceholder')}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={tooLong || undefined}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {t('forget.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !reason.trim() || tooLong}
            onClick={() => void erase()}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t('forget.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
