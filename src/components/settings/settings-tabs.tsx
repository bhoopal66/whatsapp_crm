'use client';

import { useTranslations } from 'next-intl';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollFadeRow } from '@/components/ui-ext/scroll-fade-row';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICONS,
  SECTION_META,
  type SettingsCategory,
  type SettingsSection,
} from './settings-sections';

// tabs.tsx is generated and styles its tabs with `dark:`, which matches
// nothing here (dark mode is html[data-mode='dark']).
export const TABS_TRIGGER_DARK =
  '[[data-mode=dark]_&]:text-muted-foreground [[data-mode=dark]_&]:hover:text-foreground [[data-mode=dark]_&]:data-active:border-input [[data-mode=dark]_&]:data-active:bg-input/30 [[data-mode=dark]_&]:data-active:text-foreground';
const LINE_TRIGGER_DARK =
  '[[data-mode=dark]_&]:text-muted-foreground [[data-mode=dark]_&]:hover:text-foreground [[data-mode=dark]_&]:data-active:text-foreground';

/**
 * The two Settings tab rows: categories (icon + label), then the active
 * category's sub-tabs. Both scroll sideways rather than wrap. A category
 * with one sub-tab (Overview) shows no second row, and AI Agents brings
 * its own, so the page passes `subTabs={null}` for it.
 */
export function SettingsTabs({
  categories,
  category,
  section,
  subTabs,
  onCategory,
  onSection,
}: {
  categories: SettingsCategory[];
  category: SettingsCategory;
  section: SettingsSection;
  subTabs: SettingsSection[] | null;
  onCategory: (c: SettingsCategory) => void;
  onSection: (s: SettingsSection) => void;
}) {
  const t = useTranslations('Settings');

  return (
    <div className="space-y-3">
      <Tabs
        value={category}
        onValueChange={(v) => onCategory(v as SettingsCategory)}
      >
        <ScrollFadeRow
          activeKey={category}
          className="border-border [scrollbar-width:none] border-b pb-1.5 [&::-webkit-scrollbar]:hidden"
        >
          <TabsList variant="line" aria-label={t('pageTitle')}>
            {categories.map((id) => {
              const Icon = CATEGORY_ICONS[id];
              return (
                <TabsTrigger
                  key={id}
                  value={id}
                  className={cn('flex-none px-2.5', LINE_TRIGGER_DARK)}
                >
                  <Icon />
                  {t(`categories.${id}`)}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </ScrollFadeRow>
      </Tabs>

      {subTabs && subTabs.length > 1 ? (
        <Tabs
          value={section}
          onValueChange={(v) => onSection(v as SettingsSection)}
        >
          <ScrollFadeRow activeKey={section} className="-mx-1 px-1 pb-1">
            <TabsList aria-label={t(`categories.${category}`)}>
              {subTabs.map((id) => {
                const Icon = SECTION_META[id].icon;
                return (
                  <TabsTrigger
                    key={id}
                    value={id}
                    className={cn('flex-none px-2.5', TABS_TRIGGER_DARK)}
                  >
                    <Icon />
                    {t(`sections.${id}`)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </ScrollFadeRow>
        </Tabs>
      ) : null}
    </div>
  );
}
