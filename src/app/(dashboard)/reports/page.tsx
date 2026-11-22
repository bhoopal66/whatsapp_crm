import { ChevronRight, Funnel, Tags } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ComponentType } from 'react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { getCurrentAccount } from '@/lib/auth/account';
import { isBankGuest } from '@/lib/auth/roles';
import {
  parseReportKeys,
  reportsFor,
  type ReportEntry,
  type ReportEntryKey,
} from '@/lib/reports/access';

const ICONS: Record<ReportEntryKey, ComponentType<{ className?: string }>> = {
  funnel: Funnel,
  chat_tags: Tags,
};

/**
 * The Reports landing: the reports this person may open, as cards.
 * The layout has already let them in (admin and up, or a report key);
 * which cards show is `reportsFor`, and each report's own guard and
 * SQL still decide on its page.
 */
export default async function ReportsPage() {
  let entries: ReportEntry[] | null = null;
  try {
    const ctx = await getCurrentAccount();
    let keys: string[] = [];
    if (!isBankGuest(ctx.role)) {
      const { data, error } = await ctx.supabase.rpc('report_my_access');
      if (!error) keys = parseReportKeys(data);
    }
    entries = reportsFor(ctx.role, keys);
  } catch {
    entries = null;
  }
  // Outside the try: redirect() throws to do its job.
  if (entries === null) redirect('/login');

  const t = await getTranslations('Reports');

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>
      {entries.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {entries.map((entry) => {
            const Icon = ICONS[entry.key];
            return (
              <li key={entry.key}>
                <Link
                  href={entry.href}
                  className="group border-border bg-card hover:bg-card-2 focus-visible:ring-primary flex h-full items-start gap-3 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-sm font-medium">
                      {t(`entries.${entry.key}.name`)}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {t(`entries.${entry.key}.description`)}
                    </span>
                  </span>
                  <ChevronRight className="text-muted-foreground mt-1 h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
