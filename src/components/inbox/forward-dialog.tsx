'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import { isOffline, thrownSendKind } from '@/lib/inbox/failed-send';
import {
  matchForwardTargets,
  mergeForwardTargets,
  recentForwardTargets,
  searchForwardTargets,
  type ForwardTarget,
} from '@/lib/inbox/forward-targets';
import { INBOX_SEARCH_DEBOUNCE_MS } from '@/lib/inbox/search';
import {
  MAX_FORWARD_TARGETS,
  type ForwardTargetResult,
} from '@/lib/whatsapp/forward';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ReplyQuote, buildReplyPreview } from './reply-quote';

interface ForwardDialogProps {
  /** The message being forwarded; the dialog is closed when null. */
  message: Message | null;
  /** Who sent it, for the preview chip, as its bubble names them. */
  authorLabel: string;
  /** The thread the message lives in — not offered as a destination. */
  sourceConversationId: string;
  onClose: () => void;
}

export function ForwardDialog({
  message,
  authorLabel,
  sourceConversationId,
  onClose,
}: ForwardDialogProps) {
  const t = useTranslations('Inbox.forward');
  const tQuote = useTranslations('Inbox.replyQuote');
  const { accountId } = useAuth();
  const open = message !== null;

  // Never cached (`lib/client-cache.ts`): conversations stay fresh.
  const [targets, setTargets] = useState<ForwardTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const term = search.trim();
  // What the server found for a term: any chat, not only a recent one.
  const [found, setFound] = useState<{
    term: string;
    list: ForwardTarget[] | null;
  } | null>(null);
  // Every chat listed so far, so one picked under another term keeps its name.
  const [known, setKnown] = useState<ReadonlyMap<string, ForwardTarget>>(
    () => new Map()
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // Fresh list every time the dialog opens.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const list = await recentForwardTargets(createClient(), {
          accountId,
          exclude: sourceConversationId,
          unknown: t('unknownContact'),
        });
        if (cancelled) return;
        setTargets(list);
        setKnown(
          (k) => new Map([...k, ...list.map((c) => [c.id, c] as const)])
        );
      } catch (err) {
        if (cancelled) return;
        console.error(
          'Failed to load forward targets:',
          (err as { message?: string })?.message
        );
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, sourceConversationId, t]);

  useEffect(() => {
    if (!open || !accountId || !term) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchForwardTargets(
        createClient(),
        {
          accountId,
          exclude: sourceConversationId,
          unknown: t('unknownContact'),
        },
        term
      )
        .then((list) => {
          if (cancelled) return;
          setFound({ term, list });
          setKnown(
            (k) => new Map([...k, ...list.map((c) => [c.id, c] as const)])
          );
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to search forward targets:', err?.message);
          setFound({ term, list: null });
        });
    }, INBOX_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, accountId, sourceConversationId, term, t]);

  const answered = found?.term === term ? found : null;
  const searching = !!term && !answered;
  // What is missing from the list, if anything.
  const failed =
    !!term && answered?.list === null
      ? t('searchFailed')
      : loadFailed
        ? t('loadFailed')
        : null;
  const filtered = useMemo(
    () =>
      mergeForwardTargets(
        matchForwardTargets(targets, search),
        answered?.list ?? []
      ),
    [targets, search, answered]
  );

  const atLimit = selected.length >= MAX_FORWARD_TARGETS;

  // Set, not toggle: idempotent if the label and the checkbox both
  // report the same click.
  const setChecked = (id: string, next: boolean) => {
    setSelected((prev) => {
      if (!next) return prev.filter((x) => x !== id);
      if (prev.includes(id) || prev.length >= MAX_FORWARD_TARGETS) return prev;
      return [...prev, id];
    });
  };

  const reset = () => {
    setSearch('');
    setFound(null);
    setSelected([]);
    setSending(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next || sending) return;
    reset();
    onClose();
  };

  const handleSend = async () => {
    if (!message || selected.length === 0 || sending) return;
    setSending(true);
    const offlineBefore = isOffline();
    try {
      const res = await fetch('/api/whatsapp/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: message.id,
          conversation_ids: selected,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A proxy's 5xx hides what was sent before it gave up.
        toast.error(
          res.status >= 500 && !body.error
            ? t('maybeSent')
            : t('failed', { reason: body.error ?? res.statusText })
        );
        setSending(false);
        return;
      }

      const results: ForwardTargetResult[] = body.results ?? [];
      const nameOf = (id: string) => known.get(id)?.name ?? t('unknownContact');
      const sent = results.filter((r) => r.ok).length;
      for (const r of results) {
        if (!r.ok) {
          const name = nameOf(r.conversation_id);
          toast.error(
            r.maybeSent
              ? t('maybeSentFor', { name })
              : t('failedFor', { name, reason: r.error ?? '' })
          );
        }
      }
      if (sent > 0) toast.success(t('sent', { count: sent }));

      // Keep the dialog open when nothing went, so the agent can adjust
      // the selection instead of starting over.
      if (sent > 0) {
        reset();
        onClose();
      } else {
        // One that may have gone is not offered again by default.
        setSelected((ids) =>
          ids.filter(
            (id) =>
              !results.some((r) => r.conversation_id === id && r.maybeSent)
          )
        );
        setSending(false);
      }
    } catch (err) {
      toast.error(
        thrownSendKind(offlineBefore, isOffline()) === 'offline'
          ? t('failed', {
              reason: err instanceof Error ? err.message : t('networkError'),
            })
          : t('maybeSent')
      );
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { max: MAX_FORWARD_TARGETS })}
          </DialogDescription>
        </DialogHeader>

        {message && (
          <ReplyQuote
            authorLabel={authorLabel}
            preview={buildReplyPreview(message, tQuote)}
          />
        )}

        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="ps-8"
            autoFocus
          />
        </div>

        {filtered.length > 0 && (failed || searching) && (
          <p
            role={failed ? 'alert' : undefined}
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            {!failed && <Loader2 className="h-3 w-3 animate-spin" />}
            {failed ?? t('searching')}
          </p>
        )}

        <div className="border-border max-h-72 min-h-24 overflow-y-auto rounded-md border">
          {loading || (searching && filtered.length === 0) ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p
              role={failed ? 'alert' : undefined}
              className="text-muted-foreground py-8 text-center text-xs"
            >
              {failed ?? t('noChats')}
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {filtered.map((c) => {
                const checked = selected.includes(c.id);
                const disabled = !checked && atLimit;
                return (
                  <li key={c.id}>
                    <label
                      className={cn(
                        'hover:bg-muted/60 flex cursor-pointer items-center gap-3 px-3 py-2',
                        disabled && 'cursor-not-allowed opacity-50'
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(next) =>
                          setChecked(c.id, next === true)
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{c.name}</span>
                        {c.phone && c.phone !== c.name && (
                          <span className="text-muted-foreground block truncate text-xs">
                            <span dir="ltr">{c.phone}</span>
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <span className="text-muted-foreground me-auto self-center text-xs">
            {t('selectedCount', {
              count: selected.length,
              max: MAX_FORWARD_TARGETS,
            })}
          </span>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={sending}
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSend}
            disabled={selected.length === 0 || sending}
          >
            {sending && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
