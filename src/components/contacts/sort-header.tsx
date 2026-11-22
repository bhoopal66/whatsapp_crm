'use client';

import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  ariaSortFor,
  type ContactSort,
  type ContactSortKey,
} from '@/lib/contacts/sort';

/**
 * A sortable column header: a button inside a `th[aria-sort]`. The
 * state is shown by an arrow icon, not by colour alone.
 */
export function SortHeader({
  sortKey,
  current,
  onSort,
  disabled = false,
  title,
  className,
  children,
}: {
  sortKey: ContactSortKey;
  current: ContactSort;
  onSort: (key: ContactSortKey) => void;
  /** Sorting does not apply (e.g. results are ranked by best match). */
  disabled?: boolean;
  /** Why the header is disabled, as a tooltip. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const state = disabled ? 'none' : ariaSortFor(current, sortKey);
  const Icon =
    state === 'ascending'
      ? ArrowUp
      : state === 'descending'
        ? ArrowDown
        : ArrowUpDown;
  return (
    <TableHead
      aria-sort={state}
      // On the cell, not the button: a disabled button gets no hover.
      title={title}
      className={cn('text-muted-foreground font-semibold', className)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSort(sortKey)}
        className="hover:text-foreground focus-visible:ring-ring -mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default disabled:opacity-60"
      >
        {children}
        <Icon
          aria-hidden
          className={cn('size-3.5', state === 'none' && 'opacity-50')}
        />
      </button>
    </TableHead>
  );
}
