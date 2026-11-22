'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { PersonOption } from '@/lib/assignment/ui';
import { cn } from '@/lib/utils';

/**
 * Who a rotation picks from (migration 236): a checklist of people,
 * where nobody ticked means everyone (all live agents and team leaders).
 * The order of `value` is the rotation order; a newly ticked person
 * joins the end.
 */
export function AssignmentPeoplePicker({
  people,
  value,
  onChange,
  disabled = false,
  className,
}: {
  people: readonly PersonOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('ChatAssignment.picker');
  const baseId = useId();
  const picked = new Set(value);

  const toggle = (userId: string, on: boolean) => {
    if (on) {
      if (!picked.has(userId)) onChange([...value, userId]);
    } else {
      onChange(value.filter((v) => v !== userId));
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {value.length === 0
            ? t('everyone')
            : t('picked', { count: value.length })}
        </p>
        {value.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {t('pickEveryone')}
          </Button>
        ) : null}
      </div>
      {people.length === 0 ? (
        <p className="border-border bg-card-2 text-muted-foreground rounded-md border p-3 text-xs">
          {t('nobody')}
        </p>
      ) : (
        <ul className="border-border bg-card divide-border max-h-56 divide-y overflow-y-auto rounded-md border">
          {people.map((p) => {
            const id = `${baseId}-${p.userId}`;
            return (
              <li key={p.userId}>
                <label
                  htmlFor={id}
                  className={cn(
                    'flex min-w-0 items-center gap-3 px-3 py-2',
                    disabled
                      ? 'cursor-not-allowed opacity-60'
                      : 'hover:bg-muted/50 cursor-pointer'
                  )}
                >
                  <Checkbox
                    id={id}
                    checked={picked.has(p.userId)}
                    disabled={disabled}
                    onCheckedChange={(next) => toggle(p.userId, next === true)}
                  />
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                    {p.name}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
