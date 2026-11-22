'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  PenLine,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFormatter, useTranslations } from 'next-intl';
import {
  coverageBadge,
  defaultGapView,
  knownIntent,
  splitTopics,
  trimExamples,
  type GapTopicView,
} from '@/lib/kb/gap-topics-view';
import type { KbEntry } from '@/lib/kb/types';
import { cn } from '@/lib/utils';

type GapView = 'topics' | 'questions';
type TopicBusy = { id: string; action: 'write' | 'status' };

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
  onWriteAnswer,
}: {
  accountId: string | null;
  canEdit: boolean;
  /** Hands a freshly created draft answer to the Answers tab's editor.
   *  Without it the topic cards offer no "Write an approved answer". */
  onWriteAnswer?: (entry: KbEntry) => void;
}) {
  const t = useTranslations('Settings.aiKnowledgeGaps');
  const tk = useTranslations('KnowledgeGaps');
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const [topics, setTopics] = useState<GapTopicView[]>([]);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [topicsLoading, setTopicsLoading] = useState(true);
  // Null until the person picks: then Topics whenever any topic exists.
  const [view, setView] = useState<GapView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [topicBusy, setTopicBusy] = useState<TopicBusy | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const fetchTopics = useCallback(async () => {
    setTopicsLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge/gaps/topics', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setTopics(Array.isArray(data?.topics) ? data.topics : []);
        setComputedAt(
          typeof data?.computed_at === 'string' ? data.computed_at : null
        );
        setNow(Date.now());
      } else toast.error(data?.error ?? tk('loadFailed'));
    } catch {
      toast.error(tk('loadFailed'));
    } finally {
      setTopicsLoading(false);
    }
  }, [tk]);

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
    setView(null);
    void fetchGaps();
    void fetchTopics();
  }, [accountId, canEdit, fetchGaps, fetchTopics]);

  // Recompute now (the daily cron does the same). Topic ids change on
  // every recompute, so the list is re-read rather than patched.
  const refreshTopics = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/ai/knowledge/gaps/topics', {
        method: 'POST',
      });
      if (res.status === 429) {
        toast.error(tk('refreshRecently'));
        return;
      }
      if (!res.ok) {
        toast.error(tk('refreshFailed'));
        return;
      }
      await fetchTopics();
    } catch {
      toast.error(tk('refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const setTopicStatus = async (
    topic: GapTopicView,
    status: GapTopicView['status']
  ) => {
    setTopicBusy({ id: topic.id, action: 'status' });
    try {
      const res = await fetch(`/api/ai/knowledge/gaps/topics/${topic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setTopics((list) =>
          list.map((x) =>
            x.id === topic.id
              ? {
                  ...x,
                  status,
                  dismissed_at:
                    status === 'dismissed' ? new Date().toISOString() : null,
                }
              : x
          )
        );
      } else if (res.status === 404) {
        // A recompute replaced the ids since this list was read.
        toast.error(data?.error ?? tk('changed'));
        await fetchTopics();
      } else toast.error(data?.error ?? tk('updateFailed'));
    } catch {
      toast.error(tk('updateFailed'));
    } finally {
      setTopicBusy(null);
    }
  };

  // Creates a draft approved answer for the topic's question and hands
  // it to the Answers tab, whose editor deletes it again if the dialog
  // closes without a save.
  const writeAnswer = async (topic: GapTopicView) => {
    if (!onWriteAnswer) return;
    setTopicBusy({ id: topic.id, action: 'write' });
    try {
      const res = await fetch('/api/ai/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: topic.label }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.entry) onWriteAnswer(data.entry as KbEntry);
      else toast.error(data?.error ?? tk('writeFailed'));
    } catch {
      toast.error(tk('writeFailed'));
    } finally {
      setTopicBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch('/api/ai/knowledge/gaps', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      if (res.ok) {
        setGaps((g) => g.filter((row) => row.id !== id));
        // Topic counts are live: the removed question leaves its topic.
        void fetchTopics();
      } else toast.error(t('removeFailed'));
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
        void fetchTopics();
      } else toast.error(t('removeFailed'));
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setClearing(false);
    }
  };

  if (!canEdit) return null;

  const shownView: GapView | null =
    view ?? (topicsLoading ? null : defaultGapView(topics.length));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {shownView === null ? (
          <div className="text-muted-foreground flex items-center py-2 text-sm">
            <Loader2 className="me-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <Tabs value={shownView} onValueChange={(v) => setView(v as GapView)}>
            <TabsList aria-label={tk('viewLabel')}>
              <TabsTrigger value="topics">{tk('viewTopics')}</TabsTrigger>
              <TabsTrigger value="questions">{tk('viewQuestions')}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {shownView === 'topics' ? (
          <GapTopicsList
            topics={topics}
            loading={topicsLoading}
            computedAt={computedAt}
            now={now}
            refreshing={refreshing}
            busy={topicBusy}
            showDismissed={showDismissed}
            onToggleDismissed={() => setShowDismissed((v) => !v)}
            onRefresh={() => void refreshTopics()}
            onStatus={(topic, status) => void setTopicStatus(topic, status)}
            onWrite={
              onWriteAnswer ? (topic) => void writeAnswer(topic) : undefined
            }
          />
        ) : shownView === 'questions' ? (
          <>
            {loading ? (
              <div className="text-muted-foreground flex items-center py-2 text-sm">
                <Loader2 className="me-2 h-4 w-4 animate-spin" /> {t('loading')}
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
                <RefreshCw className="me-2 h-4 w-4" /> {t('refresh')}
              </Button>
              {gaps.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void clearAll()}
                  disabled={clearing}
                  className="text-muted-foreground"
                >
                  {clearing && (
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                  )}
                  {t('clearAll')}
                </Button>
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const TONE_CLASS = {
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
} as const;

function relative(
  format: ReturnType<typeof useFormatter>,
  iso: string | null,
  now: number
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : format.relativeTime(d, now);
}

/** The Topics view: header (Refresh, last computed), open topics, and
 *  the collapsed dismissed group. */
function GapTopicsList({
  topics,
  loading,
  computedAt,
  now,
  refreshing,
  busy,
  showDismissed,
  onToggleDismissed,
  onRefresh,
  onStatus,
  onWrite,
}: {
  topics: GapTopicView[];
  loading: boolean;
  computedAt: string | null;
  now: number;
  refreshing: boolean;
  busy: TopicBusy | null;
  showDismissed: boolean;
  onToggleDismissed: () => void;
  onRefresh: () => void;
  onStatus: (topic: GapTopicView, status: GapTopicView['status']) => void;
  onWrite?: (topic: GapTopicView) => void;
}) {
  const tk = useTranslations('KnowledgeGaps');
  const format = useFormatter();
  const { open, dismissed } = splitTopics(topics);
  const updated = relative(format, computedAt, now);

  const card = (topic: GapTopicView) => (
    <GapTopicCard
      key={topic.id}
      topic={topic}
      now={now}
      busy={busy?.id === topic.id ? busy.action : null}
      disabled={busy !== null || refreshing}
      onStatus={onStatus}
      onWrite={onWrite}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {updated ? tk('updated', { when: updated }) : tk('neverUpdated')}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing || loading}
        >
          {refreshing ? (
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="me-2 h-4 w-4" />
          )}
          {refreshing ? tk('refreshing') : tk('refresh')}
        </Button>
      </div>

      {loading && topics.length === 0 ? (
        <div className="text-muted-foreground flex items-center py-2 text-sm">
          <Loader2 className="me-2 h-4 w-4 animate-spin" /> {tk('loading')}
        </div>
      ) : open.length === 0 && dismissed.length === 0 ? (
        <div className="space-y-1 py-2">
          <p className="text-foreground text-sm">{tk('empty')}</p>
          <p className="text-muted-foreground text-xs">{tk('emptyHint')}</p>
        </div>
      ) : (
        <>
          {open.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {tk('allDismissed')}
            </p>
          ) : (
            <ul className="space-y-2">{open.map(card)}</ul>
          )}
          {dismissed.length > 0 && (
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground -ms-2"
                aria-expanded={showDismissed}
                onClick={onToggleDismissed}
              >
                {showDismissed ? (
                  <ChevronDown className="me-1 h-4 w-4" />
                ) : (
                  <ChevronRight className="me-1 h-4 w-4 rtl:rotate-180" />
                )}
                {tk('dismissedGroup', { count: dismissed.length })}
              </Button>
              {showDismissed && (
                <ul className="space-y-2">{dismissed.map(card)}</ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One topic: its representative question, size, recency, intent chip
 * and coverage badge, the other ways it was asked, and its actions.
 * Exported for the server-rendered test; the node test environment
 * cannot click, so the states are pinned there and the handlers here.
 */
export function GapTopicCard({
  topic,
  now,
  busy,
  disabled,
  onStatus,
  onWrite,
}: {
  topic: GapTopicView;
  now: number;
  busy: TopicBusy['action'] | null;
  disabled: boolean;
  onStatus: (topic: GapTopicView, status: GapTopicView['status']) => void;
  onWrite?: (topic: GapTopicView) => void;
}) {
  const tk = useTranslations('KnowledgeGaps');
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const badge = coverageBadge(topic);
  const intent = knownIntent(topic.intent);
  const examples = trimExamples(topic.label, topic.examples);
  const lastSeen = relative(format, topic.last_seen_at, now);
  const dismissed = topic.status === 'dismissed';

  return (
    <li
      className={cn(
        'border-border bg-card-2 space-y-2 rounded-md border p-3',
        dismissed && 'opacity-80'
      )}
    >
      <p className="text-foreground text-sm font-medium break-words">
        {topic.label}
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{tk('questionCount', { count: topic.question_count })}</span>
        {lastSeen && (
          <>
            <span aria-hidden>·</span>
            <span title={new Date(topic.last_seen_at).toLocaleString()}>
              {tk('lastSeen', { when: lastSeen })}
            </span>
          </>
        )}
        {intent && (
          <span className="bg-secondary text-secondary-foreground inline-flex h-5 items-center rounded-full px-2 font-medium">
            {tk(`intent.${intent}`)}
          </span>
        )}
        {badge && (
          <span
            className={cn(
              'inline-flex h-5 max-w-full items-center truncate rounded-full px-2 font-medium',
              TONE_CLASS[badge.tone]
            )}
          >
            {badge.kind === 'none'
              ? tk('coverage.none')
              : badge.entry
                ? tk(`coverage.${badge.kind}`, { entry: badge.entry })
                : tk(`coverage.${badge.kind}Unknown`)}
          </span>
        )}
      </div>
      {badge?.kind === 'full' && (
        <p className="text-muted-foreground text-xs">
          {tk('coverage.fullHint')}
        </p>
      )}

      {examples.length > 0 && (
        <div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center text-xs"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown className="me-1 h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="me-1 h-3.5 w-3.5 rtl:rotate-180" />
            )}
            {tk('examples', { count: examples.length })}
          </button>
          {expanded && (
            <ul className="text-muted-foreground mt-1 space-y-1 ps-5 text-xs">
              {examples.map((q) => (
                <li key={q} className="list-disc break-words">
                  {q}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {onWrite && !dismissed && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onWrite(topic)}
          >
            {busy === 'write' ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <PenLine className="me-2 h-4 w-4" />
            )}
            {tk('write')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={disabled}
          onClick={() => onStatus(topic, dismissed ? 'open' : 'dismissed')}
        >
          {busy === 'status' ? (
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
          ) : dismissed ? (
            <RotateCcw className="me-2 h-4 w-4" />
          ) : (
            <X className="me-2 h-4 w-4" />
          )}
          {dismissed ? tk('reopen') : tk('dismiss')}
        </Button>
      </div>
    </li>
  );
}
