'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  flipContactSortDir,
  isServerSortKey,
  pickContactSortKey,
  type ContactSort,
  type ContactSortKey,
} from '@/lib/contacts/sort';

/**
 * Sorting on a phone. The column headers past Name are hidden below
 * `lg`, so this shows only there (`lg:hidden`): a "Sort by" field and a
 * direction button, driving the same sort state the headers do. A native
 * select, which a phone opens as its own picker.
 */
export function MobileSort({
  keys,
  current,
  onChange,
  disabled = false,
  serverSortMissing = false,
  className,
}: {
  keys: ContactSortKey[];
  current: ContactSort;
  onChange: (next: ContactSort) => void;
  /** Sorting does not apply (results are ranked by best match). */
  disabled?: boolean;
  /** Migration 257 is missing: the RPC-sorted keys cannot apply. */
  serverSortMissing?: boolean;
  className?: string;
}) {
  const t = useTranslations('Contacts.page.tableColumns');
  const tTable = useTranslations('ContactsTable');
  const label: Record<ContactSortKey, string> = {
    name: t('name'),
    owner: t('createdBy'),
    assignee: t('assignedTo'),
    activity: t('lastActivity'),
    created: t('createdAt'),
  };
  const DirIcon = current.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <div className={cn('flex items-center gap-2 lg:hidden', className)}>
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span className="text-muted-foreground shrink-0">
          {tTable('sortBy')}
        </span>
        <select
          value={current.sort}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              pickContactSortKey(current, e.target.value as ContactSortKey)
            )
          }
          className="border-input bg-card dark:bg-input/30 h-9 min-w-0 flex-1 rounded-md border px-2 text-sm disabled:opacity-60"
        >
          {keys.map((k) => (
            <option
              key={k}
              value={k}
              disabled={serverSortMissing && isServerSortKey(k)}
            >
              {label[k]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(flipContactSortDir(current))}
        aria-label={
          current.dir === 'asc'
            ? tTable('sortDescending')
            : tTable('sortAscending')
        }
        className="border-input bg-card dark:bg-input/30 focus-visible:ring-ring inline-flex size-9 shrink-0 items-center justify-center rounded-md border focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
      >
        <DirIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
