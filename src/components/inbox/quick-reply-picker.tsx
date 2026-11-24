'use client';

import { useEffect, useState } from 'react';
import { Loader2, MessageSquare, Search, SearchX, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/dashboard/empty-state';
import { matchQuickReplies } from '@/lib/inbox/slash-quick-replies';
import type { QuickReply } from '@/types';
import { interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

/**
 * Lists the account's saved quick replies for insertion into the
 * composer. Text snippets fill the textarea; interactive snippets open
 * the builder pre-filled (handled by the caller's `onPick`).
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations('Inbox.composer');
  const tMenu = useTranslations('ComposerMenu');
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Filters on title, shortcut and body (the "/" list's matcher).
  // Emptied each time the picker opens.
  const [query, setQuery] = useState('');
  const [openFor, setOpenFor] = useState(open);
  if (openFor !== open) {
    setOpenFor(open);
    if (open) setQuery('');
  }
  const shown = matchQuickReplies(items, query, Infinity);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch('/api/quick-replies', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setItems((data.quick_replies as QuickReply[]) ?? []);
      } catch {
        // A list read earlier stays usable.
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('quickReplies')}</DialogTitle>
        </DialogHeader>
        {items.length > 0 && (
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tMenu('searchQuickReplies')}
              aria-label={tMenu('searchQuickReplies')}
              className="ps-8"
            />
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : failed && items.length === 0 ? (
            <div className="py-8 text-center" role="alert">
              <p className="text-muted-foreground text-sm">
                {tMenu('quickRepliesFailed')}
              </p>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="text-primary mt-2 text-sm font-medium hover:underline"
              >
                {tMenu('quickRepliesRetry')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t('quickRepliesEmpty')}
            </p>
          ) : shown.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={tMenu('searchNoMatch')}
              className="min-h-0 py-6"
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {shown.map((qr) => (
                <li key={qr.id}>
                  <button
                    type="button"
                    onClick={() => onPick(qr)}
                    className="border-border bg-muted/40 hover:border-primary/50 hover:bg-muted flex w-full items-start gap-2 rounded-md border p-2.5 text-start"
                  >
                    {qr.kind === 'interactive' ? (
                      <Zap className="text-primary mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <MessageSquare className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {qr.title}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {qr.kind === 'interactive' && qr.interactive_payload
                          ? interactivePayloadPreviewText(
                              qr.interactive_payload
                            )
                          : qr.content_text}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
