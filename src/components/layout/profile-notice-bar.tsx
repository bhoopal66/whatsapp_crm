'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';

/**
 * Says that this tab shows a workspace the person no longer works in. In
 * the shell's flow above the page, so it covers nothing; and a bar, not a
 * reload, because there may be text typed and not yet sent.
 */
export function ProfileNoticeBar() {
  const { profileNotice, followProfileNotice, dismissProfileNotice } =
    useAuth();
  const t = useTranslations('AccountAccess');
  if (!profileNotice) return null;

  return (
    <div
      role="status"
      className="bg-warning-soft text-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm sm:px-6"
    >
      <p className="min-w-0 flex-1 basis-48">
        {profileNotice.kind === 'switched'
          ? t('switchedElsewhere')
          : t('workspaceDeactivated')}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={followProfileNotice}>
          {t('reload')}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismissProfileNotice}>
          {t('dismiss')}
        </Button>
      </div>
    </div>
  );
}
