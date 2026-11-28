'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CONTACT_SORT_KEYS,
  isServerSortKey,
  type ContactSort,
  type ContactSortKey,
} from '@/lib/contacts/sort';

/**
 * The sort control for screens too narrow for the column headers (they
 * show from `lg` up): a key picker and a direction button, on the same
 * `changeSort` the headers use. Picking another key starts at that key's
 * own direction; the button flips the current one.
 */
export function SortPicker({
  current,
  onSort,
  disabled = false,
  serverSortMissing = false,
  className,
}: {
  current: ContactSort;
  onSort: (key: ContactSortKey) => void;
  /** Results are ranked by best match; sorting does not apply. */
  disabled?: boolean;
  /** Migration 257 is not applied: owner / assignee / activity are off. */
  serverSortMissing?: boolean;
  className?: string;
}) {
  const t = useTranslations('Contacts.page');
  const tTable = useTranslations('ContactsTable');

  const labels: Record<ContactSortKey, string> = {
    name: t('tableColumns.name'),
    created: t('tableColumns.createdAt'),
    owner: t('tableColumns.createdBy'),
    assignee: t('tableColumns.assignedTo'),
    activity: t('tableColumns.lastActivity'),
  };
  const descending = current.dir === 'desc';
  const DirIcon = descending ? ArrowDown : ArrowUp;

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <Select
          value={current.sort}
          disabled={disabled}
          onValueChange={(v) => {
            const key = CONTACT_SORT_KEYS.find((k) => k === v);
            if (key && key !== current.sort) onSort(key);
          }}
        >
          <SelectTrigger
            aria-label={tTable('sortBy')}
            title={disabled ? tTable('sortedByRelevance') : undefined}
            className="min-w-36"
          >
            <SelectValue>{labels[current.sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CONTACT_SORT_KEYS.map((key) => (
              <SelectItem
                key={key}
                value={key}
                disabled={serverSortMissing && isServerSortKey(key)}
              >
                {labels[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled}
          onClick={() => onSort(current.sort)}
          aria-label={
            descending ? tTable('sortDescending') : tTable('sortAscending')
          }
          title={
            descending ? tTable('sortDescending') : tTable('sortAscending')
          }
        >
          <DirIcon aria-hidden className="size-4" />
        </Button>
      </div>
      {serverSortMissing && (
        <p className="text-muted-foreground mt-1 text-xs">
          {tTable('sortUnavailable')}
        </p>
      )}
    </div>
  );
}
