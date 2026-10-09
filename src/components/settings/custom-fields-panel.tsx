'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CustomFieldsPanel } from '@/components/contacts/custom-fields-manager';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Settings → Custom fields. Manages the account-wide custom contact
 * field catalogue (the same panel the Contacts page exposes via a
 * dialog). The section is admin-only (settings-sections.ts) and
 * `custom_fields` RLS rejects non-admin writes regardless.
 */
export function CustomFieldsSettings() {
  const t = useTranslations('Settings.customFields');

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <SlidersHorizontal className="text-primary size-4" />
            {t('fieldsTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('fieldsDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomFieldsPanel />
        </CardContent>
      </Card>
    </section>
  );
}
