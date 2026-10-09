import { cn } from '@/lib/utils';

/**
 * The red "Important" label on a chat the AI handed to a person
 * (migration 078) — in the conversation list and on the thread's
 * banner. Solid destructive red with white text, the same in light and
 * dark mode: the one loud thing on the row.
 */
export function ImportantBadge({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'bg-destructive inline-flex shrink-0 items-center rounded px-1.5 text-[10px] leading-4 font-semibold tracking-wide text-white uppercase',
        className
      )}
    >
      {label}
    </span>
  );
}
