import { cn } from '@/lib/utils';
import type { PersonPresence } from '@/lib/person-presence';

/**
 * Solid green = available, red = on a call, hollow ring = away or
 * offline, solid grey = off work, grey with a line = Do not disturb (the
 * phone's states, lib/person-presence.ts). Fixed colours: the sidebar is
 * dark in both modes.
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
        state === 'online' && 'bg-emerald-400',
        state === 'on_call' && 'bg-red-500',
        (state === 'dnd' || state === 'off_work') && 'bg-zinc-400',
        (state === 'away' || state === 'offline') &&
          'border-[1.5px] border-white/50 bg-transparent',
        className
      )}
    >
      {state === 'dnd' && (
        <span className="absolute inset-x-0.5 top-1/2 h-[1.5px] -translate-y-1/2 rounded-full bg-white" />
      )}
    </span>
  );
}
