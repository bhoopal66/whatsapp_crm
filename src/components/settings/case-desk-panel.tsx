'use client';

/**
 * Settings -> Case desk (owners and admins): everything about the case
 * desk that is configured rather than worked in. The daily-work tabs
 * (upload, sorting, tray, companies, overview) stay on /desk.
 *
 * Sections, top to bottom: desk codes (migration 220), the bank
 * coordinators (232), WhatsApp routing (230) and the customer reminder
 * digest (234). Each one is its own card with its own save.
 */
import { useTranslations } from 'next-intl';

import { CoverRolesEditor } from '@/components/desk/cover-card';
import { DeskCodes } from '@/components/desk/desk-codes';
import { DigestSettings } from '@/components/desk/digest-settings';
import { RoutingSettings } from '@/components/desk/routing-settings';
import { CsatSettingsCard } from '@/components/settings/csat-settings-card';
import { useAuth } from '@/hooks/use-auth';

export function CaseDeskPanel() {
  const t = useTranslations('CaseDeskSettings');
  const { accountId } = useAuth();
  // Keyed by workspace: a switch never shows the last one's settings.
  const key = accountId ?? '';
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>

      <section className="space-y-2" aria-labelledby="case-desk-codes">
        <h2
          id="case-desk-codes"
          className="text-foreground text-base font-semibold"
        >
          {t('codes')}
        </h2>
        <DeskCodes key={`codes-${key}`} />
      </section>

      <section className="space-y-2" aria-labelledby="case-desk-cover">
        <h2
          id="case-desk-cover"
          className="text-foreground text-base font-semibold"
        >
          {t('cover')}
        </h2>
        <CoverRolesEditor key={`cover-${key}`} />
      </section>

      <RoutingSettings key={`routing-${key}`} />
      <DigestSettings key={`digest-${key}`} />

      <CsatSettingsCard />
    </div>
  );
}
