import { cn } from '@/lib/utils';
import type { PresenceDot as Dot } from '@/lib/chat/view';

/** Solid green = available, red = on a call, hollow ring = away/offline. */
export function PresenceDot({
  state,
  className,
}: {
  state: Dot;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        state === 'available' && 'bg-emerald-400',
        state === 'busy' && 'bg-red-500',
        state === 'offline' && 'border-[1.5px] border-white/50 bg-transparent',
        className
      )}
    />
  );
}
