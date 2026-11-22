'use client';

import { Columns3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  OPTIONAL_COLUMNS,
  toggleHidden,
  type ColumnPrefs,
} from '@/lib/contacts/columns';

/**
 * "Columns": a checklist of the optional columns plus the "Hide empty
 * columns" switch. Name and phone are not listed: they cannot be hidden.
 */
export function ColumnsMenu({
  prefs,
  onChange,
}: {
  prefs: ColumnPrefs;
  onChange: (next: ColumnPrefs) => void;
}) {
  const t = useTranslations('ContactsTable');
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
        <Columns3 className="size-4" />
        {t('columns')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-border border-b px-3 py-2">
          <span className="text-popover-foreground text-sm font-medium">
            {t('columns')}
          </span>
        </div>
        <label className="hover:bg-muted/50 flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-1.5">
          <Checkbox
            checked={prefs.hideEmpty}
            onCheckedChange={(checked) =>
              onChange({ ...prefs, hideEmpty: checked === true })
            }
          />
          <span className="text-popover-foreground text-sm">
            {t('hideEmpty')}
          </span>
        </label>
        <div className="border-border border-t py-1">
          <p className="text-muted-foreground px-3 py-1 text-xs">
            {t('alwaysShown')}
          </p>
          {OPTIONAL_COLUMNS.map((column) => (
            <label
              key={column}
              className="hover:bg-muted/50 flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-1.5"
            >
              <Checkbox
                checked={!prefs.hidden.includes(column)}
                onCheckedChange={() => onChange(toggleHidden(prefs, column))}
              />
              <span className="text-popover-foreground text-sm">
                {t(`column.${column}`)}
              </span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
