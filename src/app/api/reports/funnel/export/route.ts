import { getTranslations } from 'next-intl/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildCsv, csvFileName, csvResponse } from '@/lib/csv/build';
import {
  FUNNEL_METRICS,
  NO_LEAD_SOURCE,
  funnelCsvRows,
  isFunnelLeadSource,
  type FunnelCsvLabels,
  type FunnelMetric,
} from '@/lib/reports/funnel';
import { loadFunnelReport } from '@/lib/reports/funnel-server';

/**
 * GET /api/reports/funnel/export?<same parameters as /api/reports/funnel>
 *   → text/csv attachment
 *
 * The same report as the page, as one long table (funnelCsvRows in
 * lib/reports/funnel.ts). Owners and admins only. Cells are quoted and
 * formula-neutralised by lib/csv/build.ts.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const loaded = await loadFunnelReport(
      supabase,
      accountId,
      new URL(request.url).searchParams
    );
    if (!loaded.ok) return loaded.response;

    const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';
    const t = await getTranslations({ locale, namespace: 'FunnelReport' });
    const tSource = await getTranslations({
      locale,
      namespace: 'ContactsTable.source',
    });
    const labels: FunnelCsvLabels = {
      breakdown: t('csv.breakdown'),
      item: t('csv.item'),
      metrics: Object.fromEntries(
        FUNNEL_METRICS.map((m) => [m, t(`stages.${m}`)])
      ) as Record<FunnelMetric, string>,
      sections: {
        total: t('csv.total'),
        ofPrevious: t('csv.ofPrevious'),
        ofNewChats: t('csv.ofNewChats'),
        source: t('breakdown.bySource'),
        agent: t('breakdown.byAgent'),
        number: t('breakdown.byNumber'),
        bank: t('breakdown.byBank'),
      },
      all: t('csv.all'),
      unassigned: t('breakdown.unassigned'),
      noNumber: t('breakdown.noNumber'),
      noBank: t('breakdown.noBank'),
      source: (key) =>
        key === NO_LEAD_SOURCE
          ? t('filters.noSource')
          : isFunnelLeadSource(key)
            ? tSource(key)
            : key,
    };

    const { header, rows } = funnelCsvRows(loaded.report, labels);
    return csvResponse(
      buildCsv(header, rows),
      csvFileName(`funnel-report-${loaded.range.preset}`)
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
