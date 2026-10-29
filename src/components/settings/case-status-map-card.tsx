'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowRight,
  Info,
  Loader2,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  chipFor,
  mappedLabel,
  mergeSuggestions,
  parseApplied,
  parseMapping,
  parseStatusMap,
  parseSuggestions,
  percent,
  statusMapError,
  unmappedLabel,
  withSaved,
  type MappedRow,
  type MapSource,
  type StageSuggestion,
  type StatusMapView,
  type UnmappedRow,
} from '@/lib/cases/status-map-view';

const URL_BASE = '/api/cases/status-map';
const WARN = 'border-warning/30 bg-warning-soft text-warning';

type Answer = { ok: boolean; status: number; body: unknown };

/** One status-map call; a network failure is a status-0 answer. */
async function call(url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.json().catch(() => null),
    };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/**
 * Settings -> Cases: which case stage each Compass status name means
 * (migration 151). The table paints from `?suggestions=0`; Jev's
 * suggestions (5-15 s on a cold cache) arrive from a second, full GET and
 * fill the chips. A failed suggestion read shows no chips and no error.
 * Admin+, like the panel it sits in and the routes behind it.
 */
export function CaseStatusMapCard() {
  const t = useTranslations('StatusMap');
  const [view, setView] = useState<StatusMapView | null>(null);
  const [failed, setFailed] = useState(false);
  const [suggestions, setSuggestions] = useState<
    Record<string, StageSuggestion>
  >({});
  const [suggesting, setSuggesting] = useState(false);
  // Session-only: rows the admin chose to leave, and saved rows still
  // offering "Move N open cases now".
  const [left, setLeft] = useState<Set<string>>(() => new Set());
  const [justSaved, setJustSaved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // Per row: one row finishing must not re-enable another mid-request.
  const setRowBusy = (key: string, on: boolean) =>
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const [removing, setRemoving] = useState<MappedRow | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchSuggestions = useCallback(async (stages: string[]) => {
    setSuggesting(true);
    const answer = await call(URL_BASE);
    if (!alive.current) return;
    setSuggesting(false);
    if (answer.ok)
      setSuggestions((prev) =>
        mergeSuggestions(prev, parseSuggestions(answer.body, stages))
      );
  }, []);

  /** The table (quiet: keep what is shown when the read fails). */
  const readTable = useCallback(async (quiet: boolean) => {
    const answer = await call(`${URL_BASE}?suggestions=0`);
    if (!alive.current) return null;
    const next = answer.ok ? parseStatusMap(answer.body) : null;
    if (next) {
      setView(next);
      setFailed(false);
    } else if (!quiet) setFailed(true);
    return next;
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    setView(null);
    const next = await readTable(false);
    if (next?.available && next.unmapped.length > 0)
      void fetchSuggestions(next.stages);
  }, [readTable, fetchSuggestions]);

  useEffect(() => {
    // The first read; state lands only in the fetch's callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function errorToast(answer: Answer) {
    const e = statusMapError(answer.body, answer.status);
    toast.error(
      'key' in e ? t(`errors.${e.key}`) : t('errors.generic', { error: e.text })
    );
  }

  async function save(
    row: UnmappedRow,
    stage: string,
    source: MapSource,
    suggestedP?: number
  ) {
    setRowBusy(row.status_key, true);
    const answer = await call(URL_BASE, {
      method: 'PUT',
      body: JSON.stringify({
        status: unmappedLabel(row),
        stage,
        source,
        ...(suggestedP === undefined ? {} : { suggestedP }),
      }),
    });
    if (!alive.current) return;
    setRowBusy(row.status_key, false);
    const mapping = answer.ok ? parseMapping(answer.body) : null;
    if (!mapping) {
      errorToast(answer);
      return;
    }
    setView((v) => (v ? withSaved(v, mapping) : v));
    setJustSaved((s) => new Set(s).add(mapping.status_key));
    toast.success(
      t('saved', { status: unmappedLabel(row), stage: mapping.stage })
    );
    // Re-read quietly for the server's unresolved count.
    void readTable(true);
  }

  async function apply(row: MappedRow) {
    setRowBusy(row.status_key, true);
    const answer = await call(`${URL_BASE}/apply`, {
      method: 'POST',
      body: JSON.stringify({ status: mappedLabel(row) }),
    });
    if (!alive.current) return;
    setRowBusy(row.status_key, false);
    const counts = answer.ok ? parseApplied(answer.body) : null;
    if (!counts) {
      errorToast(answer);
      return;
    }
    setJustSaved((s) => {
      const next = new Set(s);
      next.delete(row.status_key);
      return next;
    });
    toast.success(t('applied', counts));
  }

  async function remove(row: MappedRow) {
    setRowBusy(row.status_key, true);
    const answer = await call(
      `${URL_BASE}?status=${encodeURIComponent(mappedLabel(row))}`,
      { method: 'DELETE' }
    );
    if (!alive.current) return;
    setRowBusy(row.status_key, false);
    if (!answer.ok) {
      errorToast(answer);
      return;
    }
    toast.success(t('removed', { status: mappedLabel(row) }));
    const next = await readTable(true);
    // The status may be unmapped again: ask Jev about it too.
    if (next?.available && next.unmapped.length > 0)
      void fetchSuggestions(next.stages);
  }

  const unmapped = view?.unmapped.filter((u) => !left.has(u.status_key)) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('explainer')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="text-muted-foreground flex gap-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>{t('finalNote')}</p>
        </div>

        {failed ? (
          <div className="flex items-center justify-between gap-3" role="alert">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : !view ? (
          <div
            className="bg-muted/50 h-32 w-full animate-pulse rounded-xl"
            aria-busy="true"
          />
        ) : view.unmapped.length === 0 && view.mapped.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <>
            {!view.available && view.unmapped.length > 0 ? (
              <p className="border-info/30 bg-info-soft text-info rounded-lg border px-3 py-2 text-sm">
                {t('needsJev')}
              </p>
            ) : null}

            {view.unmapped.length > 0 ? (
              <section className="space-y-2">
                <h4 className="text-foreground text-sm font-semibold">
                  {t('unmappedHeading')}
                </h4>
                {unmapped.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('allLeft')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {unmapped.map((row) => (
                      <UnmappedItem
                        key={row.status_key}
                        row={row}
                        stages={view.stages}
                        suggestion={
                          view.available
                            ? suggestions[row.status_key]
                            : undefined
                        }
                        suggesting={view.available && suggesting}
                        busy={busy.has(row.status_key)}
                        onSave={(stage, source, p) =>
                          void save(row, stage, source, p)
                        }
                        onLeave={() =>
                          setLeft((s) => new Set(s).add(row.status_key))
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {view.mapped.length > 0 ? (
              <section className="space-y-2">
                <h4 className="text-foreground text-sm font-semibold">
                  {t('mappedHeading')}
                </h4>
                <ul className="space-y-2">
                  {view.mapped.map((row) => (
                    <MappedItem
                      key={row.status_key}
                      row={row}
                      offerMove={
                        justSaved.has(row.status_key) && row.open_cases > 0
                      }
                      busy={busy.has(row.status_key)}
                      onMove={() => void apply(row)}
                      onRemove={() => setRemoving(row)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('removeTitle')}
        description={t('removeBody', {
          status: removing ? mappedLabel(removing) : '',
        })}
        cancelLabel={t('cancel')}
        confirmLabel={t('remove')}
        destructive
        onConfirm={() => {
          const row = removing;
          setRemoving(null);
          if (row) void remove(row);
        }}
      />
    </Card>
  );
}

function UnmappedItem({
  row,
  stages,
  suggestion,
  suggesting,
  busy,
  onSave,
  onLeave,
}: {
  row: UnmappedRow;
  stages: string[];
  suggestion: StageSuggestion | undefined;
  suggesting: boolean;
  busy: boolean;
  onSave: (stage: string, source: MapSource, p?: number) => void;
  onLeave: () => void;
}) {
  const t = useTranslations('StatusMap');
  const [stage, setStage] = useState<string | null>(null);
  const chip = suggestion ? chipFor(suggestion) : null;

  return (
    <li className="bg-card-2 border-border space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-medium">
            {unmappedLabel(row)}
          </p>
          <p className="text-muted-foreground text-xs">
            {t('openCases', { count: row.open_cases })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {chip ? (
            <>
              <Badge
                variant="outline"
                className="border-info/30 bg-info-soft text-info gap-1"
              >
                <Sparkles className="size-3" />
                {chip.kind === 'stage'
                  ? t('chip', { stage: chip.stage, pct: chip.pct })
                  : t('chipNone', { pct: chip.pct })}
              </Badge>
              {/* "No stage change" is not a mapping: the PUT needs a stage. */}
              {chip.kind === 'stage' && suggestion ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onSave(chip.stage, 'suggestion', suggestion.p)}
                >
                  {t('accept')}
                </Button>
              ) : null}
            </>
          ) : suggesting ? (
            <Loader2
              className="text-muted-foreground size-4 animate-spin"
              aria-label={t('suggesting')}
            />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Select
            value={stage}
            onValueChange={(v) => setStage(typeof v === 'string' ? v : null)}
          >
            <SelectTrigger
              className="w-full"
              aria-label={t('pickLabel', { status: unmappedLabel(row) })}
            >
              <SelectValue>{stage ?? t('pickPlaceholder')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !stage}
          onClick={() => stage && onSave(stage, 'admin')}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onLeave}>
          {t('leave')}
        </Button>
      </div>
    </li>
  );
}

function MappedItem({
  row,
  offerMove,
  busy,
  onMove,
  onRemove,
}: {
  row: MappedRow;
  offerMove: boolean;
  busy: boolean;
  onMove: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('StatusMap');
  return (
    <li className="bg-card-2 border-border space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground font-medium">
            {mappedLabel(row)}
          </span>
          <ArrowRight className="text-muted-foreground size-4" />
          <span className="text-foreground">{row.stage}</span>
          {row.source === 'suggestion' ? (
            <Badge
              variant="outline"
              className="border-info/30 bg-info-soft text-info"
            >
              {row.suggested_p === null
                ? t('byJev')
                : t('byJevPct', { pct: percent(row.suggested_p) })}
            </Badge>
          ) : (
            <Badge variant="outline">{t('byAdmin')}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {offerMove ? (
            <Button size="sm" disabled={busy} onClick={onMove}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('moveNow', { count: row.open_cases })}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t('removeLabel', { status: mappedLabel(row) })}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {(row.unresolved_open_cases ?? 0) > 0 ? (
        <p
          className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${WARN}`}
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t('unresolved', { count: row.unresolved_open_cases ?? 0 })}
        </p>
      ) : null}
    </li>
  );
}
