'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { useTranslations } from 'next-intl';

import {
  JOURNEY_STAGES,
  LABELLED_STATES,
  countByStage,
  stateLabelKey,
} from '@/lib/journeys/ui';

interface JourneyRow {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  conversationId: string | null;
  state: string;
  product: string | null;
  entry: string | null;
  outcome: { kind: string; reason: string } | null;
  open: boolean;
  updatedAt: string;
}

const LIMIT = 200;
const PRODUCTS = ['POS', 'ACCOUNT', 'LOAN'] as const;
const selectClass =
  'border-input bg-background text-foreground h-8 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** GET /api/journeys with `params`; null when it failed. */
async function fetchJourneys(
  params: Record<string, string>
): Promise<JourneyRow[] | null> {
  const q = new URLSearchParams({ limit: String(LIMIT), ...params });
  const res = await fetch(`/api/journeys?${q}`).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    journeys?: JourneyRow[];
  } | null;
  return json?.journeys ?? null;
}

/**
 * The Journeys screen (module 016): how many of the latest journeys sit
 * at each stage, and a filterable list linking each one to its chat.
 * RLS decides which journeys come back (customers the caller can see).
 */
export default function JourneysPage() {
  const t = useTranslations('Journeys');
  const [all, setAll] = useState<JourneyRow[] | null>(null);
  const [rows, setRows] = useState<JourneyRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState('');
  const [product, setProduct] = useState('');
  const [openOnly, setOpenOnly] = useState(true);

  useEffect(() => {
    fetchJourneys({}).then((j) => {
      setAll(j);
      setFailed(j === null);
    });
  }, []);

  useEffect(() => {
    if (!state && !product) return;
    let live = true;
    fetchJourneys({
      ...(state ? { state } : {}),
      ...(product ? { product } : {}),
    }).then((j) => {
      if (!live) return;
      setRows(j);
      setFailed(j === null);
    });
    return () => {
      live = false;
    };
  }, [state, product]);

  const counts = useMemo(() => countByStage(all ?? []), [all]);
  const listed = (state || product ? rows : all) ?? [];
  const shown = openOnly ? listed.filter((j) => j.open) : listed;
  const label = (s: string) => (stateLabelKey(s) ? t(`states.${s}`) : s);

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-5">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>

        <section className="bg-card rounded-lg border p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-foreground text-sm font-medium">
              {t('page.funnel')}
            </h2>
            {all && (
              <span className="text-muted-foreground text-xs">
                {t('page.funnelNote', { count: all.length })}
              </span>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {JOURNEY_STAGES.map((s) => (
              <div
                key={s}
                className={`rounded-md px-2 py-2 text-center ${
                  s === 'parked' || s === 'closed' ? 'bg-muted/60' : 'bg-muted'
                }`}
              >
                <div className="text-foreground text-lg font-semibold tabular-nums">
                  {counts[s]}
                </div>
                <div className="text-muted-foreground truncate text-[11px]">
                  {t(`stages.${s}`)}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label={t('page.stage')}
            className={selectClass}
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">{t('page.allStages')}</option>
            {LABELLED_STATES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select
            aria-label={t('page.product')}
            className={selectClass}
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          >
            <option value="">{t('page.allProducts')}</option>
            {PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {t(`products.${p}`)}
              </option>
            ))}
          </select>
          <label className="text-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary h-4 w-4"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
            {t('page.openOnly')}
          </label>
        </div>

        {failed ? (
          <p className="text-destructive text-sm">{t('page.loadError')}</p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {all === null ? '…' : t('page.empty')}
          </p>
        ) : (
          <div className="bg-card overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.customer')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.state')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.product')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.entry')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.outcome')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('page.columns.updated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((j) => (
                  <tr
                    key={j.id}
                    className="hover:bg-muted/50 border-b last:border-0"
                  >
                    <td className="px-3 py-2">
                      {j.conversationId ? (
                        <Link
                          href={`/inbox?c=${j.conversationId}`}
                          title={t('page.openChat')}
                          className="text-foreground font-medium hover:underline"
                        >
                          {j.contactName || j.contactPhone || j.contactId}
                        </Link>
                      ) : (
                        <span title={t('page.noChat')}>
                          {j.contactName || j.contactPhone || j.contactId}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{label(j.state)}</td>
                    <td className="px-3 py-2">
                      {j.product ? t(`products.${j.product}`) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {j.entry ? t(`entry.${j.entry}`) : '—'}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {j.outcome
                        ? `${t(`outcomes.${j.outcome.kind}`)} · ${
                            t.has(`reasons.${j.outcome.reason}`)
                              ? t(`reasons.${j.outcome.reason}`)
                              : j.outcome.reason
                          }`
                        : '—'}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                      {format(new Date(j.updatedAt), 'MMM d, HH:mm')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
