'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useHrTeamNav } from '@/hooks/use-hr-team-nav';
import { hrLandingPath } from '@/lib/hr/tabs';

/**
 * /hr, the sidebar's one HR row: opens the first HR screen this person's
 * roles allow (the tab bar above lists the rest). Replaces, so Back does
 * not land on a blank redirect page.
 */
export default function HrHomePage() {
  const t = useTranslations('HrTabs');
  const router = useRouter();
  const roles = useHrTeamNav();
  const target = hrLandingPath(roles);

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return (
    <p role="status" className="text-muted-foreground p-6 text-sm">
      {t('opening')}
    </p>
  );
}
