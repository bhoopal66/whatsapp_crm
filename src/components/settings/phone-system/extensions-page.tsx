'use client';

// Settings → Phone extensions: who answers which PBX extension. The
// mapping used to be a wide table inside Settings → Phone system; it is
// its own page now, with name matches from the PBX, a search, and a
// per-person view. Every rule that matters is still the server's
// (PATCH /api/pbx/extensions/[id], pbx_extensions_guard); the pure half
// of this page is lib/pbx/extension-mapping.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ChevronsUpDown,
  Info,
  Loader2,
  PhoneOff,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  applyExtensionPatch,
  canEditExtension,
  extensionState,
  workspaceChangePatch,
  type ExtensionPatch,
  type MappableWorkspace,
  type PbxConnectionView,
  type PbxExtensionView,
} from '@/lib/pbx/admin-ui';
import {
  filterExtensions,
  freeExtensions,
  mappingSummary,
  mergeSynced,
  normalizeName,
  peopleRows,
  personOptions,
  planLink,
  suggestMappings,
  suggestionStillValid,
  withPbxFields,
  personKey,
  type ExtensionFilter,
  type MappingSuggestion,
} from '@/lib/pbx/extension-mapping';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from '../settings-panel-head';
import { DOT, pbxFetch } from './fetch';

type Row = PbxExtensionView;
type Phase = 'loading' | 'failed' | 'none' | 'ready';
type SyncResult = { extensions: Row[]; total: number; added: number };

export function PhoneExtensionsPanel() {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  const tx = useTranslations('Settings.phoneSystem.extensions');
  const { workspaces: mine } = useAuth();
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<Row[]>([]);
  const [workspaces, setWorkspaces] = useState<MappableWorkspace[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [namesFailed, setNamesFailed] = useState(false);
  const [linkingAll, setLinkingAll] = useState(false);
  const [view, setView] = useState<'extension' | 'person'>('extension');
  // The rows as the last write left them, so a sequence of PATCHes
  // (a move, Link all) always starts from the newest row.
  const rowsRef = useRef<Row[]>([]);
  // Requests in flight per row: a count, because a move and a switch can
  // both be on one row and the first to finish must not clear the other.
  const busyRef = useRef<Map<string, number>>(new Map());
  // When this page last wrote each row (a counter, not a clock), so a
  // sync that started before the write does not roll it back.
  const writeClock = useRef(0);
  const writtenAt = useRef<Map<string, number>>(new Map());

  const update = (fn: (prev: Row[]) => Row[]) => {
    rowsRef.current = fn(rowsRef.current);
    setRows(rowsRef.current);
  };
  const flag = (ids: string[], on: boolean) => {
    const next = new Map(busyRef.current);
    for (const id of ids) {
      const n = (next.get(id) ?? 0) + (on ? 1 : -1);
      if (n > 0) next.set(id, n);
      else next.delete(id);
    }
    busyRef.current = next;
    setBusy(new Set(next.keys()));
  };

  // A sync's rows win, except a row with a request in flight, or written
  // since the sync was asked for, keeps its state and takes only the
  // PBX's name.
  const syncFromPbx = async () => {
    const since = writeClock.current;
    const res = await pbxFetch<SyncResult>('/api/pbx/extensions/sync', {
      method: 'POST',
    });
    if (res.ok)
      update((prev) =>
        mergeSynced(
          prev,
          res.data.extensions,
          (id) =>
            busyRef.current.has(id) || (writtenAt.current.get(id) ?? 0) > since
        )
      );
    return res;
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const [c, x] = await Promise.all([
        pbxFetch<{ connection: PbxConnectionView | null }>(
          '/api/pbx/connection'
        ),
        pbxFetch<{ extensions: Row[]; workspaces: MappableWorkspace[] }>(
          '/api/pbx/extensions'
        ),
      ]);
      if (!live) return;
      if (!c.ok) return setPhase('failed');
      if (!c.data.connection) return setPhase('none');
      if (!x.ok) return setPhase('failed');
      setWorkspaces(x.data.workspaces);
      update(() => x.data.extensions);
      setPhase('ready');
      // Once, quietly: the PBX's names and any new extensions.
      const s = await syncFromPbx();
      if (!live) return;
      if (!s.ok) setNamesFailed(true);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first load only
  }, []);

  const refresh = async () => {
    setSyncing(true);
    const res = await syncFromPbx();
    setSyncing(false);
    if (res.ok) {
      setNamesFailed(false);
      toast.success(
        tx('synced', { total: res.data.total, added: res.data.added })
      );
    } else
      toast.error(tx('syncFailed'), { description: res.error ?? undefined });
  };

  // One optimistic PATCH; an error puts the row back and, unless quiet,
  // is toasted. The caller flags.
  const patch = async (
    id: string,
    p: ExtensionPatch,
    quiet = false
  ): Promise<{ ok: boolean; error?: string | null }> => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return { ok: false };
    const put = (v: Row) => {
      writtenAt.current.set(id, ++writeClock.current);
      update((prev) => prev.map((r) => (r.id === id ? v : r)));
    };
    put(applyExtensionPatch(row, p, workspaces));
    const res = await pbxFetch<{ extension: Row }>(
      `/api/pbx/extensions/${id}`,
      { method: 'PATCH', body: p }
    );
    // The PBX's name and on-PBX flag come only from a sync, which may
    // have landed while this request was out: take them from the row as
    // it is now, never from the copy taken before the PATCH.
    const current = () => rowsRef.current.find((r) => r.id === id);
    if (res.ok) {
      put(withPbxFields(res.data.extension, current() ?? row));
      return { ok: true };
    }
    put(withPbxFields(row, current() ?? row));
    if (!quiet)
      toast.error(tx('saveFailed', { extension: row.extension }), {
        description: res.error ?? undefined,
      });
    return { ok: false, error: res.error };
  };

  const link = async (extensionId: string, userId: string | null) => {
    const target = rowsRef.current.find((r) => r.id === extensionId);
    // The person being linked is busy too, for the whole link or move:
    // between a move's unlink and its link they hold nothing, and another
    // pick of them would race it (one extension per person, 409).
    const who = userId && target ? personKey(target.accountId, userId) : null;
    if (who && busyRef.current.has(who)) return;
    const steps = planLink(extensionId, userId, rowsRef.current);
    if (steps.length === 0) return;
    const ids = steps.map((s) => s.extensionId);
    if (who) ids.push(who);
    flag(ids, true);
    try {
      if (steps.length === 1) {
        await patch(extensionId, { userId });
        return;
      }
      // A move: off the person's old extension, then onto this one. A
      // failed unlink stops the link (it would be a 409); a failed link
      // puts the person back on the old one rather than leave them with
      // none.
      const from = rowsRef.current.find((r) => r.id === steps[0].extensionId);
      const to = rowsRef.current.find((r) => r.id === extensionId);
      if (!from || !to || userId === null) return;
      const name =
        workspaces
          .find((w) => w.accountId === to.accountId)
          ?.people.find((p) => p.userId === userId)?.name ??
        from.personName ??
        '';
      const names = { name, from: from.extension, to: to.extension };
      if (!(await patch(from.id, { userId: null })).ok) return;
      const on = await patch(to.id, { userId }, true);
      if (on.ok) {
        toast.success(t('moved', names));
        return;
      }
      const back = await patch(from.id, { userId }, true);
      toast.error(t(back.ok ? 'moveFailedKept' : 'moveFailedStranded', names), {
        description: on.error ?? undefined,
      });
    } finally {
      flag(ids, false);
    }
  };

  const setField = async (id: string, p: ExtensionPatch) => {
    flag([id], true);
    try {
      await patch(id, p);
    } finally {
      flag([id], false);
    }
  };

  const suggestions = useMemo(
    () => suggestMappings(rows, workspaces),
    [rows, workspaces]
  );
  const summary = useMemo(
    () => mappingSummary(rows, workspaces),
    [rows, workspaces]
  );

  const linkAll = async () => {
    setLinkingAll(true);
    // One after another; a failure is toasted and the rest still run.
    // The list is the one shown at the click, so each is re-checked
    // against the newest rows: a link made by hand meanwhile wins, and
    // Link all never moves anyone.
    for (const s of suggestions) {
      if (busyRef.current.has(s.extensionId)) continue;
      const ext = rowsRef.current.find((r) => r.id === s.extensionId);
      if (ext && busyRef.current.has(personKey(ext.accountId, s.userId)))
        continue;
      if (!suggestionStillValid(s, rowsRef.current)) continue;
      await link(s.extensionId, s.userId);
    }
    setLinkingAll(false);
  };

  const wsName = (id: string) =>
    workspaces.find((w) => w.accountId === id)?.name ??
    mine.find((w) => w.accountId === id)?.name ??
    t('otherWorkspace');

  const head = (
    <SettingsPanelHead
      title={t('title')}
      description={t('subtitle')}
      action={
        phase === 'ready' ? (
          <Button variant="outline" onClick={refresh} disabled={syncing}>
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('refresh')}
          </Button>
        ) : null
      }
    />
  );

  if (phase !== 'ready')
    return (
      <div className="min-w-0 space-y-6">
        {head}
        {phase === 'loading' ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </p>
        ) : phase === 'failed' ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : (
          <section className="border-border bg-card flex flex-col items-start gap-3 rounded-xl border p-6">
            <PhoneOff className="text-muted-foreground size-6" />
            <div>
              <h3 className="text-foreground font-semibold">
                {t('noConnection')}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t('noConnectionHint')}
              </p>
            </div>
            <Link
              href="/settings?tab=phone-system"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('openPhoneSystem')}
            </Link>
          </section>
        )}
      </div>
    );

  return (
    <div className="min-w-0 space-y-6">
      {head}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('stats.total')} value={summary.total} />
        <Stat
          label={t('stats.linked')}
          value={summary.linked}
          className="text-success"
        />
        <Stat
          label={t('stats.unlinked')}
          value={summary.unlinked}
          className={summary.unlinked ? 'text-warning' : undefined}
        />
        <Stat
          label={t('stats.peopleWithout')}
          value={summary.peopleWithout}
          className={summary.peopleWithout ? 'text-warning' : undefined}
        />
      </div>

      {namesFailed ? (
        <p className="text-muted-foreground text-xs">{t('namesUnavailable')}</p>
      ) : null}

      {suggestions.length > 0 ? (
        <Suggestions
          suggestions={suggestions}
          rows={rows}
          busy={busy}
          linkingAll={linkingAll}
          onLink={(s) => void link(s.extensionId, s.userId)}
          onLinkAll={() => void linkAll()}
        />
      ) : null}

      <Tabs
        value={view}
        onValueChange={(v) => setView(v as 'extension' | 'person')}
      >
        <TabsList aria-label={t('tabs.label')}>
          <TabsTrigger value="extension">{t('tabs.byExtension')}</TabsTrigger>
          <TabsTrigger value="person">{t('tabs.byPerson')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === 'extension' ? (
        <ByExtension
          rows={rows}
          workspaces={workspaces}
          suggestions={suggestions}
          busy={busy}
          wsName={wsName}
          onLink={(id, userId) => void link(id, userId)}
          onField={(id, p) => void setField(id, p)}
        />
      ) : (
        <ByPerson
          rows={rows}
          workspaces={workspaces}
          busy={busy}
          onLink={(id, userId) => void link(id, userId)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className="border-border bg-card rounded-lg border px-3 py-2">
      <div className={cn('text-xl font-semibold tabular-nums', className)}>
        {value}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Suggestions({
  suggestions,
  rows,
  busy,
  linkingAll,
  onLink,
  onLinkAll,
}: {
  suggestions: MappingSuggestion[];
  rows: Row[];
  busy: Set<string>;
  linkingAll: boolean;
  onLink: (s: MappingSuggestion) => void;
  onLinkAll: () => void;
}) {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  return (
    <section className="border-info/30 bg-info-soft rounded-xl border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="text-info size-4" />
          {t('suggestions.title')}
        </h3>
        <Button size="sm" onClick={onLinkAll} disabled={linkingAll}>
          {linkingAll ? <Loader2 className="animate-spin" /> : null}
          {t('suggestions.linkAll', { count: suggestions.length })}
        </Button>
      </div>
      <ul className="space-y-2">
        {suggestions.map((s) => {
          const ext = rows.find((r) => r.id === s.extensionId);
          if (!ext) return null;
          return (
            <li
              key={s.extensionId}
              className="bg-card flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm"
            >
              <span className="font-semibold tabular-nums">
                {ext.extension}
              </span>
              <span className="text-muted-foreground min-w-0 truncate">
                {ext.callerIdName}
              </span>
              <span className="text-muted-foreground" aria-hidden>
                →
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {s.name}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onLink(s)}
                disabled={linkingAll || busy.has(s.extensionId)}
              >
                {t('suggestions.link')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------- By extension ----------

function ByExtension({
  rows,
  workspaces,
  suggestions,
  busy,
  wsName,
  onLink,
  onField,
}: {
  rows: Row[];
  workspaces: MappableWorkspace[];
  suggestions: MappingSuggestion[];
  busy: Set<string>;
  wsName: (id: string) => string;
  onLink: (extensionId: string, userId: string | null) => void;
  onField: (extensionId: string, p: ExtensionPatch) => void;
}) {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  const tx = useTranslations('Settings.phoneSystem.extensions');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExtensionFilter>('all');
  const shown = filterExtensions(rows, query, filter);
  const count = (f: ExtensionFilter) => filterExtensions(rows, query, f).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('search')}
        />
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'unlinked', 'linked'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'outline'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`filters.${f}`, { count: count(f) })}
            </Button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('emptyExtensions')}</p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noResults')}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((row) => {
            const isBusy = busy.has(row.id);
            const readOnly =
              !canEditExtension(row, workspaces) || (row.mapped && !row.userId);
            const editable = !readOnly && !isBusy;
            const { state, tone } = extensionState(row);
            const suggestion = suggestions.find(
              (s) => s.extensionId === row.id
            );
            return (
              <li
                key={row.id}
                className={cn(
                  'border-border bg-card flex flex-col gap-3 rounded-xl border p-3 lg:flex-row lg:items-center',
                  isBusy && 'opacity-70'
                )}
              >
                <div className="min-w-0 lg:w-44">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold tabular-nums">
                      {row.extension}
                    </span>
                    {isBusy ? (
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    ) : null}
                  </div>
                  {row.callerIdName ? (
                    <div className="text-muted-foreground truncate text-xs">
                      {row.callerIdName}
                    </div>
                  ) : null}
                  <span className="mt-1 inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
                    <span
                      className={cn('size-2 shrink-0 rounded-full', DOT[tone])}
                    />
                    <span
                      className={cn(
                        tone === 'brown' &&
                          'text-orange-800 dark:text-orange-300',
                        tone === 'green' && 'text-success',
                        (tone === 'grey' || tone === 'muted') &&
                          'text-muted-foreground'
                      )}
                    >
                      {tx(`states.${state}`)}
                    </span>
                  </span>
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  {readOnly ? (
                    <div className="text-sm">
                      {row.personName ? (
                        <div className="font-medium">{row.personName}</div>
                      ) : null}
                      <p className="text-muted-foreground text-xs">
                        {t('readOnly', { workspace: wsName(row.accountId) })}
                      </p>
                    </div>
                  ) : (
                    <PersonPicker
                      row={row}
                      rows={rows}
                      workspaces={workspaces}
                      busy={busy}
                      disabled={!editable}
                      onPick={(userId) => onLink(row.id, userId)}
                    />
                  )}
                  {suggestion && !readOnly ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {t('suggested', { name: suggestion.name })}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!editable}
                        onClick={() => onLink(row.id, suggestion.userId)}
                      >
                        {t('suggestions.link')}
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <LabelledSwitch
                    label={t('softphone')}
                    hint={t('softphoneHint')}
                    checked={row.softphoneEnabled}
                    disabled={!editable}
                    onChange={(v) => onField(row.id, { softphoneEnabled: v })}
                  />
                  <LabelledSwitch
                    label={t('showStatus')}
                    hint={t('showStatusHint')}
                    checked={row.presenceMonitor}
                    disabled={!editable}
                    onChange={(v) => onField(row.id, { presenceMonitor: v })}
                  />
                  {!readOnly && workspaces.length > 1 ? (
                    <Select
                      value={row.accountId}
                      disabled={!editable}
                      onValueChange={(v) =>
                        v !== row.accountId &&
                        onField(
                          row.id,
                          workspaceChangePatch(row, String(v), workspaces)
                        )
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-44"
                        aria-label={t('workspace')}
                      >
                        <SelectValue>{wsName(row.accountId)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces.map((w) => (
                          <SelectItem key={w.accountId} value={w.accountId}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PersonPicker({
  row,
  rows,
  workspaces,
  busy,
  disabled,
  onPick,
}: {
  row: Row;
  rows: Row[];
  workspaces: MappableWorkspace[];
  busy: Set<string>;
  disabled: boolean;
  onPick: (userId: string | null) => void;
}) {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  const options = personOptions(row, rows, workspaces);
  return (
    <SearchPicker
      label={row.userId ? (row.personName ?? t('unnamed')) : t('notLinked')}
      muted={!row.userId}
      ariaLabel={t('pickPerson', { extension: row.extension })}
      searchPlaceholder={t('searchPeople')}
      disabled={disabled}
      first={{ label: t('nobody'), onPick: () => onPick(null) }}
      items={options.map((o) => ({
        key: o.userId,
        label: o.name ?? t('unnamed'),
        hint: o.holds ? t('has', { extension: o.holds }) : null,
        title: o.holds ? t('movesFrom', { extension: o.holds }) : undefined,
        selected: o.userId === row.userId,
        // Their extension has a request in flight: moving them now would
        // race it.
        disabled:
          (o.holdsId !== null && busy.has(o.holdsId)) ||
          busy.has(personKey(row.accountId, o.userId)),
        onPick: () => onPick(o.userId),
      }))}
    />
  );
}

// ---------- By person ----------

function ByPerson({
  rows,
  workspaces,
  busy,
  onLink,
}: {
  rows: Row[];
  workspaces: MappableWorkspace[];
  busy: Set<string>;
  onLink: (extensionId: string, userId: string | null) => void;
}) {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  const [query, setQuery] = useState('');
  const q = normalizeName(query);
  const people = peopleRows(rows, workspaces).filter(
    (p) =>
      !q ||
      normalizeName(p.name).includes(q) ||
      (p.extension?.extension.includes(query.trim()) ?? false)
  );
  const many = workspaces.length > 1;

  return (
    <div className="space-y-3">
      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder={t('searchPeople')}
      />
      {people.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {q ? t('noResults') : t('emptyPeople')}
        </p>
      ) : (
        <ul className="space-y-2">
          {people.map((p) => {
            const held = p.extension;
            const isBusy = !!held && busy.has(held.id);
            const free = freeExtensions(rows, p.accountId);
            const anyBusy =
              isBusy ||
              busy.has(personKey(p.accountId, p.userId)) ||
              free.some((f) => busy.has(f.id));
            return (
              <li
                key={`${p.accountId}:${p.userId}`}
                className="border-border bg-card flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {p.name ?? t('unnamed')}
                  </div>
                  {many ? (
                    <div className="text-muted-foreground truncate text-xs">
                      {p.workspaceName}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 sm:w-72">
                  {isBusy ? (
                    <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                  ) : null}
                  <SearchPicker
                    label={
                      held
                        ? t('extensionNumber', { extension: held.extension })
                        : t('noExtension')
                    }
                    muted={!held}
                    warn={!held}
                    ariaLabel={t('pickExtension', { name: p.name ?? '' })}
                    searchPlaceholder={t('searchExtensions')}
                    disabled={anyBusy}
                    emptyText={t('noFreeExtensions')}
                    first={
                      held
                        ? {
                            label: t('removeExtension'),
                            onPick: () => onLink(held.id, null),
                          }
                        : undefined
                    }
                    items={free.map((f) => ({
                      key: f.id,
                      label: f.extension,
                      hint: f.callerIdName ?? null,
                      onPick: () => onLink(f.id, p.userId),
                    }))}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- Small pieces ----------

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-sm">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-8"
      />
    </div>
  );
}

function LabelledSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={hint}
            />
          }
        >
          <Info className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{hint}</TooltipContent>
      </Tooltip>
    </span>
  );
}

interface PickerItem {
  key: string;
  label: string;
  hint?: string | null;
  title?: string;
  selected?: boolean;
  disabled?: boolean;
  onPick: () => void;
}

/** A button that opens a searchable list (there is no combobox in ui/). */
function SearchPicker({
  label,
  muted,
  warn,
  ariaLabel,
  searchPlaceholder,
  disabled,
  first,
  items,
  emptyText,
}: {
  label: string;
  muted?: boolean;
  warn?: boolean;
  ariaLabel: string;
  searchPlaceholder: string;
  disabled: boolean;
  first?: { label: string; onPick: () => void };
  items: PickerItem[];
  emptyText?: string;
}) {
  const t = useTranslations('Settings.phoneSystem.extensionsPage');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = normalizeName(query);
  const shown = q
    ? items.filter((i) =>
        normalizeName(`${i.label} ${i.hint ?? ''}`).includes(q)
      )
    : items;
  const pick = (fn: () => void) => {
    setOpen(false);
    setQuery('');
    fn();
  };
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not([disabled])'
      ) ?? []
    );
  // ArrowUp/ArrowDown walk the options; ArrowUp from the first goes back
  // to the search box.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = options();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') all[Math.min(i + 1, all.length - 1)]?.focus();
    else if (i <= 0) inputRef.current?.focus();
    else all[i - 1]?.focus();
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      options()[0]?.focus();
    } else if (e.key === 'Enter' && q) {
      // The first match, never "Nobody" (it is hidden while searching).
      e.preventDefault();
      const hit = shown.find((i) => !i.disabled);
      if (hit) pick(hit.onPick);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className="w-full min-w-0 justify-between font-normal"
          />
        }
      >
        <span
          className={cn(
            'truncate',
            muted && 'text-muted-foreground',
            warn && 'text-warning'
          )}
        >
          {label}
        </span>
        <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <Input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        <ul
          ref={listRef}
          className="max-h-64 overflow-y-auto"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={onListKey}
        >
          {first && !q ? (
            <li role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="text-muted-foreground hover:bg-muted focus-visible:bg-muted w-full rounded-md px-2 py-1.5 text-left text-sm outline-none"
                onClick={() => pick(first.onPick)}
              >
                {first.label}
              </button>
            </li>
          ) : null}
          {shown.map((i) => (
            <li key={i.key} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={!!i.selected}
                disabled={i.disabled}
                title={i.title}
                className={cn(
                  'hover:bg-muted focus-visible:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none disabled:pointer-events-none disabled:opacity-50',
                  i.selected && 'bg-muted font-medium'
                )}
                onClick={() => pick(i.onPick)}
              >
                <span className="min-w-0 truncate">{i.label}</span>
                {i.hint ? (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {i.hint}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            {q ? t('noMatches') : (emptyText ?? t('noMatches'))}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
