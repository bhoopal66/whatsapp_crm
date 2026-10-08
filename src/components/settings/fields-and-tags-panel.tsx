'use client';

import { useCan } from '@/hooks/use-can';

import { useTranslations } from 'next-intl';

import { CustomFieldsSettings } from './custom-fields-settings';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * "Custom fields" section. The catalogue is account-wide config, so the
 * card is admin-gated (mirroring the old hidden-tab behaviour).
 * `custom_fields` RLS rejects non-admin writes regardless. Contact tags
 * are retired; chat tags live in their own section.
 */
export function FieldsAndTagsPanel() {
  const t = useTranslations('Settings.tagsAndFields');
  const canEditSettings = useCan('edit-settings');

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      {canEditSettings ? <CustomFieldsSettings /> : null}
    </section>
  );
}
