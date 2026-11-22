'use client';

import { Filter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LEAD_SOURCES, type LeadSource } from '@/lib/contacts/lead-source';
import { LEAD_SOURCE_ICONS } from '@/components/contacts/lead-source-badge';

/** Multi-select lead-source filter (a contact matches any of them). */
export function SourceFilter({
  selected,
  onChange,
}: {
  selected: readonly LeadSource[];
  onChange: (next: LeadSource[]) => void;
}) {
  const t = useTranslations('ContactsTable');
  const tSource = useTranslations('ContactsTable.source');
  function toggle(source: LeadSource) {
    onChange(
      LEAD_SOURCES.filter((s) =>
        s === source ? !selected.includes(s) : selected.includes(s)
      )
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="border-border text-muted-foreground hover:bg-muted shrink-0"
          />
        }
      >
        <Filter className="size-4" />
        {t('filterBySource')}
        {selected.length > 0 && (
          <span className="bg-primary text-primary-foreground ms-1 inline-flex items-center justify-center rounded-full px-1.5 text-xs font-semibold">
            {selected.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <div className="border-border flex items-center justify-between border-b px-3 py-2">
          <span className="text-popover-foreground text-sm font-medium">
            {t('filterBySource')}
          </span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-muted-foreground hover:text-foreground min-h-8 text-xs"
            >
              {t('clearSources')}
            </button>
          )}
        </div>
        <div className="py-1">
          {LEAD_SOURCES.map((source) => {
            const Icon = LEAD_SOURCE_ICONS[source];
            return (
              <label
                key={source}
                className="hover:bg-muted/50 flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-1.5"
              >
                <Checkbox
                  checked={selected.includes(source)}
                  onCheckedChange={() => toggle(source)}
                />
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="text-popover-foreground text-sm">
                  {tSource(source)}
                </span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
