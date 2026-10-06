'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, HelpCircle, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

interface GapRow {
  id: string;
  conversation_id: string | null;
  question: string;
  best_score: number | null;
  created_at: string;
}

/**
 * The questions the retrieval gate refused to answer (migration 052).
 * Each is a customer message the knowledge base had nothing close
 * enough for — the list an admin works through when extending the KB.
 * Admin-only: the API and RLS both gate it, so for anyone else the card
 * is simply not rendered.
 */
export function AiKnowledgeGapsCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.aiKnowledgeGaps');
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchGaps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge/gaps');
      const data = await res.json();
      if (res.ok) setGaps(data.gaps ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canEdit || !accountId || loadedAccountIdRef.current === accountId)
      return;
    loadedAccountIdRef.current = accountId;
    void fetchGaps();
  }, [accountId, canEdit, fetchGaps]);

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch('/api/ai/knowledge/gaps', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      if (res.ok) setGaps((g) => g.filter((row) => row.id !== id));
      else toast.error(t('removeFailed'));
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/ai/knowledge/gaps', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (res.ok) {
        setGaps([]);
        toast.success(t('cleared'));
      } else toast.error(t('removeFailed'));
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setClearing(false);
    }
  };

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="text-muted-foreground flex items-center py-2 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : gaps.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-md border">
            {gaps.map((gap) => (
              <li
                key={gap.id}
                className="flex items-start justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-foreground text-sm break-words">
                    {gap.question}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {new Date(gap.created_at).toLocaleString()}
                    {typeof gap.best_score === 'number' &&
                      ` · ${t('score', { score: gap.best_score.toFixed(2) })}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-8 w-8 shrink-0 p-0"
                  onClick={() => void remove(gap.id)}
                  disabled={busyId === gap.id}
                  title={t('dismiss')}
                >
                  {busyId === gap.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchGaps()}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> {t('refresh')}
          </Button>
          {gaps.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clearAll()}
              disabled={clearing}
              className="text-muted-foreground"
            >
              {clearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('clearAll')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
