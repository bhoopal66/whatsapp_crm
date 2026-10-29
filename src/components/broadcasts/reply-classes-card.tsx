'use client';

// The Replies card on a broadcast's detail page: how the first replies
// to this campaign were sorted by Jev (docs/jev-insights.md, "Campaign
// reply sorting"), a filter for the recipients table, and the backfill
// for replies that arrived before the switch was on.
//
// Client component: it reaches the server only through
// /api/broadcasts/[id]/reply-classes and ./classify-replies. View logic
// lives in lib/broadcasts/reply-class-view.ts (dependency-free); never
// import lib/broadcasts/reply-class here, it is server-only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  REPLY_CLASS_LABEL_KEY,
  REPLY_CLASS_TONE,
  buildReplySegments,
  formatSegmentPercent,
  replySortAction,
  sortPastReplies,
  type ReplyClassName,
} from '@/lib/broadcasts/reply-class-view';

interface ReplyClassesResponse {
  counts: Partial<Record<string, number>>;
  unclassifiedReplies: number;
  enabled: boolean;
  available: boolean;
}

interface ReplyClassesCardProps {
  broadcastId: string;
  selected: ReplyClassName | null;
  onSelect: (cls: ReplyClassName | null) => void;
  /** Called after a backfill sorted something, to reload the table. */
  onSorted: () => void;
}

export function ReplyClassesCard({
  broadcastId,
  selected,
  onSelect,
  onSorted,
}: ReplyClassesCardProps) {
  const t = useTranslations('ReplyClasses');
  const [data, setData] = useState<ReplyClassesResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Replies sorted so far by the running backfill; null when idle. */
  const [sortedSoFar, setSortedSoFar] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}/reply-classes`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ReplyClassesResponse;
      if (!mounted.current) return;
      setData(body);
      setLoadFailed(false);
    } catch {
      if (mounted.current) setLoadFailed(true);
    }
  }, [broadcastId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSort() {
    setSortedSoFar(0);
    let sorted = 0;
    try {
      sorted = await sortPastReplies(
        async () => {
          const res = await fetch(
            `/api/broadcasts/${broadcastId}/classify-replies`,
            { method: 'POST' }
          );
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
          return { classified: Number(payload?.classified) || 0 };
        },
        (n) => {
          sorted = n;
          if (mounted.current) setSortedSoFar(n);
        },
        () => !mounted.current
      );
      toast.success(t('sortDone', { count: sorted }));
    } catch (err) {
      toast.error(
        t('sortFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      if (mounted.current) {
        setSortedSoFar(null);
        await load();
        if (sorted > 0) onSorted();
      }
    }
  }

  if (loadFailed && !data) {
    return (
      <div className="border-border bg-card text-muted-foreground rounded-xl border px-4 py-3 text-sm">
        {t('loadFailed')}
      </div>
    );
  }
  if (!data) return null;

  const segments = buildReplySegments(data.counts);
  // Shown only when the broadcast has replies, sorted or not.
  if (segments.length === 0 && data.unclassifiedReplies <= 0) return null;

  const action = replySortAction(data);
  const label = (cls: ReplyClassName) => t(REPLY_CLASS_LABEL_KEY[cls]);

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-foreground text-sm font-medium">{t('title')}</h2>
          <p className="text-muted-foreground text-xs">{t('subtitle')}</p>
        </div>
        {selected && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSelect(null)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('clear')}
          </Button>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        {segments.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noneSorted')}</p>
        ) : (
          <>
            <div className="bg-card-2 flex h-3 w-full overflow-hidden rounded-full">
              {segments.map((s) => (
                <button
                  key={s.cls}
                  type="button"
                  title={t('legendItem', {
                    label: label(s.cls),
                    count: s.count,
                    percent: formatSegmentPercent(s),
                  })}
                  aria-label={t('filterBy', { label: label(s.cls) })}
                  onClick={() => onSelect(selected === s.cls ? null : s.cls)}
                  style={{ width: `${s.share}%` }}
                  className={cn(
                    'h-full min-w-1 transition-opacity',
                    REPLY_CLASS_TONE[s.cls].bar,
                    selected && selected !== s.cls && 'opacity-30'
                  )}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {segments.map((s) => (
                <button
                  key={s.cls}
                  type="button"
                  aria-pressed={selected === s.cls}
                  aria-label={t('filterBy', { label: label(s.cls) })}
                  onClick={() => onSelect(selected === s.cls ? null : s.cls)}
                  className={cn(
                    'text-foreground hover:bg-card-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    selected === s.cls
                      ? 'border-ring bg-card-2'
                      : 'border-border'
                  )}
                >
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      REPLY_CLASS_TONE[s.cls].bar
                    )}
                  />
                  {t('legendItem', {
                    label: label(s.cls),
                    count: s.count,
                    percent: formatSegmentPercent(s),
                  })}
                </button>
              ))}
            </div>
          </>
        )}

        {(data.unclassifiedReplies > 0 || action) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {data.unclassifiedReplies > 0 && (
              <span className="text-muted-foreground">
                {t('unsorted', { count: data.unclassifiedReplies })}
              </span>
            )}
            {action === 'sort' &&
              (sortedSoFar === null ? (
                <Button variant="outline" size="sm" onClick={handleSort}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('sortPast', { count: data.unclassifiedReplies })}
                </Button>
              ) : (
                <span className="text-muted-foreground inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {sortedSoFar === 0
                    ? t('sorting')
                    : t('sortedSoFar', { count: sortedSoFar })}
                </span>
              ))}
            {action === 'turn_on' && (
              <span className="text-muted-foreground">{t('turnOn')}</span>
            )}
            {action === 'unavailable' && (
              <span className="text-muted-foreground">{t('unavailable')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
