'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Megaphone,
  Recycle as RecycleIcon,
  ListTodo,
  Search,
  XCircle,
} from 'lucide-react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useChatTags } from '@/hooks/use-chat-tags';
import { createClient } from '@/lib/supabase/client';
import {
  RECYCLE_HANDOFF_QUERY,
  saveRecycleHandoff,
} from '@/lib/recycle/handoff';
import {
  clampDays,
  daysSince,
  formatPhone,
  mapRecycleRow,
  settingsFromRow,
  whyKey,
} from '@/lib/recycle/rows';
import {
  RECYCLE_CASE_OUTCOMES,
  RECYCLE_MAX_BATCH,
  RECYCLE_MAX_DAYS,
  RECYCLE_MIN_DAYS,
  type RecycleCaseOutcome,
  type RecycleRow,
  type RecycleRpcRow,
  type RecycleSettings,
} from '@/lib/recycle/types';

const PAGE_SIZE = 25;

interface Picked {
  phone: string;
  name: string | null;
}

export function RecycleScreen() {
  const t = useTranslations('Recycle');
  const router = useRouter();
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const supabase = useMemo(() => createClient(), []);

  const [settings, setSettings] = useState<RecycleSettings | null>(null);
  const [days, setDays] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<RecycleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Map<string, Picked>>(new Map());
  const [busy, setBusy] = useState(false);

  const effectiveDays = days.trim()
    ? clampDays(days, settings?.days ?? 90)
    : null;

  // Settings (team leader and up read them; no row = the defaults).
  const loadSettings = useCallback(async () => {
    if (!accountId) return;
    const { data } = await supabase
      .from('recycle_settings')
      .select('days, chat_tag_ids, case_outcomes')
      .eq('account_id', accountId)
      .maybeSingle();
    setSettings(settingsFromRow(data ?? null));
  }, [accountId, supabase]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setFailed(false);
    const { data, error } = await supabase.rpc('recycle_candidates', {
      p_days: effectiveDays,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
      p_search: query || null,
    });
    if (error) {
      setFailed(true);
      setRows([]);
      setTotal(0);
    } else {
      const mapped = ((data ?? []) as RecycleRpcRow[]).map(mapRecycleRow);
      setRows(mapped);
      setTotal(mapped[0]?.total ?? 0);
    }
    setLoading(false);
  }, [accountId, supabase, effectiveDays, page, query]);

  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function togglePick(row: RecycleRow) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(row.contactId)) next.delete(row.contactId);
      else next.set(row.contactId, { phone: row.phone, name: row.name });
      return next;
    });
  }

  const pageAllPicked =
    rows.length > 0 && rows.every((r) => picked.has(r.contactId));

  function togglePage() {
    setPicked((prev) => {
      const next = new Map(prev);
      if (pageAllPicked) rows.forEach((r) => next.delete(r.contactId));
      else
        rows.forEach((r) =>
          next.set(r.contactId, { phone: r.phone, name: r.name })
        );
      return next;
    });
  }

  async function pickAllMatching() {
    setBusy(true);
    const { data, error } = await supabase.rpc('recycle_candidates', {
      p_days: effectiveDays,
      p_limit: RECYCLE_MAX_BATCH,
      p_offset: 0,
      p_search: query || null,
    });
    setBusy(false);
    if (error) {
      toast.error(t('loadFailed'));
      return;
    }
    const all = ((data ?? []) as RecycleRpcRow[]).map(mapRecycleRow);
    setPicked(
      new Map(all.map((r) => [r.contactId, { phone: r.phone, name: r.name }]))
    );
    if (total > all.length)
      toast.info(t('selectCapped', { count: all.length }));
  }

  function startCampaign() {
    const ok = saveRecycleHandoff([...picked.values()]);
    if (!ok) {
      toast.error(t('handoffFailed'));
      return;
    }
    router.push(`/broadcasts/new?${RECYCLE_HANDOFF_QUERY}`);
  }

  async function createTasks() {
    setBusy(true);
    const { data, error } = await supabase.rpc('recycle_create_tasks', {
      p_contact_ids: [...picked.keys()],
      p_days: effectiveDays,
    });
    setBusy(false);
    if (error) {
      toast.error(t('tasksFailed'));
      return;
    }
    const r = (Array.isArray(data) ? data[0] : data) as {
      created: number;
      already_filed: number;
      not_eligible: number;
    } | null;
    toast.success(
      t('tasksDone', {
        created: r?.created ?? 0,
        already: r?.already_filed ?? 0,
        skipped: r?.not_eligible ?? 0,
      })
    );
    setPicked(new Map());
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>

      {canEdit && settings && (
        <SettingsCard
          settings={settings}
          onSaved={() => {
            setPage(0);
            void loadSettings();
            void load();
          }}
        />
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="text-muted-foreground flex flex-1 flex-col gap-1 text-xs">
          {t('searchLabel')}
          <span className="relative">
            <Search className="pointer-events-none absolute top-2.5 start-2.5 size-4" />
            <Input
              className="ps-8"
              value={search}
              placeholder={t('searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(0);
                  setQuery(search.trim());
                }
              }}
              onBlur={() => {
                if (search.trim() !== query) {
                  setPage(0);
                  setQuery(search.trim());
                }
              }}
            />
          </span>
        </label>
        <label className="text-muted-foreground flex flex-col gap-1 text-xs sm:w-44">
          {t('daysLabel')}
          <Input
            inputMode="numeric"
            value={days}
            placeholder={t('daysPlaceholder', { days: settings?.days ?? 90 })}
            onChange={(e) => {
              setPage(0);
              setDays(e.target.value.replace(/\D/g, '').slice(0, 3));
            }}
          />
        </label>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <span className="text-sm font-medium">
          {t('selected', { count: picked.size })}
        </span>
        {total > rows.length && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={pickAllMatching}
          >
            {t('selectAll', { count: Math.min(total, RECYCLE_MAX_BATCH) })}
          </Button>
        )}
        {picked.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPicked(new Map())}
          >
            {t('clear')}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={picked.size === 0 || busy}
          onClick={startCampaign}
        >
          <Megaphone data-icon="inline-start" />
          {t('startCampaign')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={picked.size === 0 || busy}
          onClick={createTasks}
        >
          <ListTodo data-icon="inline-start" />
          {t('createTasks')}
        </Button>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">{t('campaignNote')}</p>

      {loading ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('loading')}
        </p>
      ) : failed ? (
        <EmptyState
          icon={XCircle}
          title={t('loadFailed')}
          hint={t('loadFailedHint')}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={RecycleIcon}
          title={t('empty')}
          hint={t('emptyHint')}
        />
      ) : (
        <>
          <div className="flex items-center gap-2 px-1">
            <Checkbox
              checked={pageAllPicked}
              onCheckedChange={togglePage}
              aria-label={t('selectPage')}
            />
            <span className="text-muted-foreground text-xs">
              {t('selectPage')}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <RecycleItem
                key={row.contactId}
                row={row}
                checked={picked.has(row.contactId)}
                onToggle={() => togglePick(row)}
              />
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {t('pageOf', { page: page + 1, pages, total })}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('next')}
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function RecycleItem({
  row,
  checked,
  onToggle,
}: {
  row: RecycleRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('Recycle');
  const ago = daysSince(row.endedAt);
  const Icon = row.outcome === 'Withdrawn' ? XCircle : CheckCircle2;
  const outcomeWord =
    row.source === 'chat'
      ? (row.chatTagName ?? t('why.chatTag'))
      : row.outcome === 'Withdrawn'
        ? t('outcome.Withdrawn')
        : t('outcome.Declined');
  const reason = row.reasonCode
    ? t.has(`reason.${row.reasonCode}`)
      ? t(`reason.${row.reasonCode}`)
      : row.reasonCode
    : null;
  return (
    <li className="border-border bg-card flex items-start gap-3 rounded-lg border p-3">
      <Checkbox
        className="mt-1"
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={t('selectOne', { name: row.name ?? row.phone })}
      />
      <div className="grid min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid-cols-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {row.name ?? t('noName')}
          </p>
          <p className="text-muted-foreground text-xs">
            {formatPhone(row.phone)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-sm">
            <Icon
              className="text-muted-foreground size-4 shrink-0"
              aria-hidden
            />
            <span className="truncate">{outcomeWord}</span>
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {[row.bankCode, reason].filter(Boolean).join(' · ') ||
              t('why.' + whyKey(row))}
          </p>
        </div>
        <div>
          <p className="text-sm">{t('daysAgo', { count: ago })}</p>
          <p className="text-muted-foreground text-xs">
            {new Date(row.endedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm">{row.ownerName ?? t('noOwner')}</p>
          <p className="text-muted-foreground truncate text-xs">
            {t('why.' + whyKey(row))}
          </p>
        </div>
      </div>
    </li>
  );
}

function SettingsCard({
  settings,
  onSaved,
}: {
  settings: RecycleSettings;
  onSaved: () => void;
}) {
  const t = useTranslations('Recycle.settings');
  const supabase = useMemo(() => createClient(), []);
  const { tags } = useChatTags();
  const mainTags = (tags ?? []).filter((x) => x.parent_id === null);
  const [days, setDays] = useState(String(settings.days));
  const [tagIds, setTagIds] = useState<string[]>(settings.chatTagIds);
  const [outcomes, setOutcomes] = useState<RecycleCaseOutcome[]>(
    settings.caseOutcomes
  );
  const [saving, setSaving] = useState(false);

  function flip<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  async function save() {
    setSaving(true);
    const { error } = await supabase.rpc('recycle_settings_set', {
      p_days: clampDays(days, settings.days),
      p_chat_tag_ids: tagIds,
      p_case_outcomes: outcomes,
    });
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saved'));
    onSaved();
  }

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-xs">{t('hint')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
          {t('days', { min: RECYCLE_MIN_DAYS, max: RECYCLE_MAX_DAYS })}
          <Input
            inputMode="numeric"
            value={days}
            onChange={(e) =>
              setDays(e.target.value.replace(/\D/g, '').slice(0, 3))
            }
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-muted-foreground mb-1 text-xs">
            {t('outcomes')}
          </legend>
          {RECYCLE_CASE_OUTCOMES.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={outcomes.includes(o)}
                onCheckedChange={() => setOutcomes((p) => flip(p, o))}
              />
              {o === 'Declined' ? t('declined') : t('withdrawn')}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-muted-foreground mb-1 text-xs">
            {t('chatTags')}
          </legend>
          {mainTags.length === 0 && (
            <p className="text-muted-foreground text-xs">{t('noTags')}</p>
          )}
          {mainTags.map((tag) => (
            <label key={tag.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={tagIds.includes(tag.id)}
                onCheckedChange={() => setTagIds((p) => flip(p, tag.id))}
              />
              <span className="truncate">{tag.name}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <div>
        <Button size="sm" disabled={saving} onClick={save}>
          {t('save')}
        </Button>
      </div>
    </section>
  );
}
