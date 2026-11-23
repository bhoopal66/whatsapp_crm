'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useHrCounts } from '@/hooks/use-hr-counts';
import { useHrTeamNav } from '@/hooks/use-hr-team-nav';
import { NAV_PREFETCH, isNavItemActive } from '@/components/layout/nav-items';
import { hasHrAccess } from '@/lib/hr/access';
import { visibleHrTabs } from '@/lib/hr/tabs';
import type { HrCounts } from '@/lib/hr/types';
import { isFullBleedPath } from '@/lib/layout/full-bleed';
import { cn } from '@/lib/utils';

/** Open-chat figure for the three inbox tabs; null for the others. */
function tabCount(href: string, counts: HrCounts | null): number | null {
  if (!counts) return null;
  switch (href) {
    case '/hr/recruiter':
      return counts.recruiter.all;
    case '/hr/department':
      return counts.dept.all;
    case '/hr/unsorted':
      return counts.unsorted;
    default:
      return null;
  }
}

/**
 * The HR area's tab bar (the sidebar has one "HR" row). Each tab is a
 * plain link to its own route, so every old /hr/* URL, back button and
 * bookmark keeps working. Tabs are the ones the person's HR roles open
 * (lib/hr/tabs.ts); the routes' HrAccessLayout is the real guard.
 */
export function HrTabs() {
  const t = useTranslations('HrTabs');
  const pathname = usePathname();
  const roles = useHrTeamNav();
  const counts = useHrCounts(!!roles && hasHrAccess(roles));
  const { accountRole, profileLoading } = useAuth();
  const tabs = visibleHrTabs(roles, profileLoading ? null : accountRole);

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label={t('label')}
      className={cn(
        'border-border bg-card shrink-0 border-b',
        // On a scrolling page the bar is a card above the content; on a
        // full-bleed inbox it is the flush strip under the top bar.
        !isFullBleedPath(pathname) && 'mb-4 rounded-lg border'
      )}
    >
      <ul className="flex gap-1 overflow-x-auto px-3 whitespace-nowrap">
        {tabs.map((tab) => {
          const active = isNavItemActive(tab.href, pathname);
          const count = tabCount(tab.href, counts);
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                prefetch={NAV_PREFETCH}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-ring flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  active
                    ? 'border-primary text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground border-transparent font-medium'
                )}
              >
                {t(tab.labelKey)}
                {count !== null && count > 0 ? (
                  <span
                    aria-label={t('openChats', { count })}
                    className="bg-muted text-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold"
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
