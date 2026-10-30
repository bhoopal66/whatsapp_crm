import { cn } from '@/lib/utils';

// Placeholder bubbles while a thread's first page loads — shown only
// when nothing is cached for the chat (lib/inbox/message-cache.ts), so
// the agent sees the shape of a conversation rather than a spinner.
// Widths are fixed, not random: the server and client render the same.
const ROWS: { out: boolean; width: string; tall?: boolean }[] = [
  { out: false, width: 'w-2/5' },
  { out: false, width: 'w-3/5', tall: true },
  { out: true, width: 'w-1/2' },
  { out: false, width: 'w-1/3' },
  { out: true, width: 'w-3/5', tall: true },
  { out: true, width: 'w-1/4' },
  { out: false, width: 'w-1/2' },
];

export function MessageSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex flex-col gap-2 py-4"
      data-testid="message-skeleton"
    >
      {ROWS.map((row, i) => (
        <div
          key={i}
          className={cn('flex', row.out ? 'justify-end' : 'justify-start')}
        >
          <div
            className={cn(
              'max-w-md animate-pulse rounded-lg opacity-70',
              row.out ? 'bg-wa-bubble-out' : 'bg-wa-bubble-in',
              row.width,
              row.tall ? 'h-14' : 'h-9'
            )}
          />
        </div>
      ))}
    </div>
  );
}
