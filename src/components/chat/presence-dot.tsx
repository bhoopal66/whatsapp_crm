import { cn } from '@/lib/utils';
import type { PersonPresence } from '@/lib/person-presence';

/**
 * Solid green = available, red = on a call, hollow ring = away or
 * offline, solid grey = off work, grey with a line = Do not disturb (the
 * phone's states, lib/person-presence.ts). Mode-aware: the sidebar
 * follows the light/dark mode.
 */
export function PresenceDot({
  state,
  label,
  className,
}: {
  state: PersonPresence;
  /** Tooltip and accessible name; decorative without one. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'relative inline-block size-2.5 shrink-0 rounded-full',
        state === 'online' && 'bg-emerald-500',
        state === 'on_call' && 'bg-red-500',
        (state === 'dnd' || state === 'off_work') && 'bg-muted-foreground',
        (state === 'away' || state === 'offline') &&
          'border-muted-foreground border-[1.5px] bg-transparent',
        className
      )}
    >
      {state === 'dnd' && (
        <span className="bg-background absolute inset-x-0.5 top-1/2 h-[1.5px] -translate-y-1/2 rounded-full" />
      )}
    </span>
  );
}
