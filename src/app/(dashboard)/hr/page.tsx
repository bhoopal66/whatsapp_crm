'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ErrorState } from '@/components/dashboard/error-state';
import { useAuth } from '@/hooks/use-auth';
import { useHrRolesState } from '@/hooks/use-hr-team-nav';
import { hrLandingPath } from '@/lib/hr/tabs';

/**
 * /hr, the sidebar's one HR row: opens the first HR screen this person's
 * roles allow (the tab bar above lists the rest). Replaces, so Back does
 * not land on a blank redirect page.
 */
export default function HrHomePage() {
  const t = useTranslations('HrTabs');
  const router = useRouter();
  const { accountRole, profileLoading } = useAuth();
  const { roles, failed, retry } = useHrRolesState();
  const target = hrLandingPath(roles, profileLoading ? null : accountRole);

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  // Without the roles there is nowhere to send them: say so and let them
  // ask again, rather than "Opening…" for ever.
  if (!target && failed) return <ErrorState onRetry={retry} />;

  return (
    <p role="status" className="text-muted-foreground p-6 text-sm">
      {t('opening')}
    </p>
  );
}
