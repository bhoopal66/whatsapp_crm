'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
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
  /** Sender label for the preview chip ("You" / the contact's name). */
  authorLabel: string;
  /** The thread the message lives in — not offered as a destination. */
  sourceConversationId: string;
  onClose: () => void;
}

interface Target {
  id: string;
  name: string;
  phone: string;
}

/**
 * How many recent chats to offer. The picker filters these client-side;
 * a chat older than this is still reachable by opening it and replying.
 * Deliberately NOT cached (`lib/client-cache.ts`): conversations must
 * stay fresh, per CLAUDE.md.
 */
const RECENT_LIMIT = 200;

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

  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // Fresh list every time the dialog opens. RLS narrows it to the chats
  // this user may see (migrations 042–044), which is also what the
  // route will accept.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await createClient()
        .from('conversations')
        .select('id, contact:contacts(name, phone)')
        .eq('account_id', accountId)
        .neq('id', sourceConversationId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(RECENT_LIMIT);
      if (cancelled) return;
      setLoading(false);
      if (error) {
        console.error('Failed to load forward targets:', error.message);
        toast.error(t('loadFailed'));
        return;
      }
      setTargets(
        (data ?? []).map((row) => {
          // A to-one embed; supabase-js types it as an array or object
          // depending on what it could infer, so accept both.
          const raw = row.contact as unknown;
          const contact = (Array.isArray(raw) ? raw[0] : raw) as {
            name?: string | null;
            phone?: string | null;
          } | null;
          return {
            id: row.id as string,
            name: contact?.name || contact?.phone || t('unknownContact'),
            phone: contact?.phone ?? '',
          };
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, sourceConversationId, t]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return targets;
    const digits = q.replace(/\D/g, '');
    return targets.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (digits.length > 0 && c.phone.replace(/\D/g, '').includes(digits))
    );
  }, [targets, search]);

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
        toast.error(t('failed', { reason: body.error ?? res.statusText }));
        setSending(false);
        return;
      }

      const results: ForwardTargetResult[] = body.results ?? [];
      const nameOf = (id: string) =>
        targets.find((c) => c.id === id)?.name ?? t('unknownContact');
      const sent = results.filter((r) => r.ok).length;
      for (const r of results) {
        if (!r.ok) {
          toast.error(
            t('failedFor', {
              name: nameOf(r.conversation_id),
              reason: r.error ?? '',
            })
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
        setSending(false);
      }
    } catch (err) {
      toast.error(
        t('failed', {
          reason: err instanceof Error ? err.message : 'network error',
        })
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
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="border-border max-h-72 min-h-24 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-xs">
              {t('noChats')}
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
                            {c.phone}
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
          <span className="text-muted-foreground mr-auto self-center text-xs">
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
            {sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
