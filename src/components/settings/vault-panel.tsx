'use client';

import { useTranslations } from 'next-intl';

/**
 * Settings -> Vault (module 019c). A placeholder slot: the section is
 * registered (admin+, Team category) and this panel is filled by a
 * later job.
 */
export function VaultPanel() {
  const t = useTranslations('Settings.overview');
  return (
    <p className="text-muted-foreground text-sm" aria-busy="true">
      {t('loading')}
    </p>
  );
}
