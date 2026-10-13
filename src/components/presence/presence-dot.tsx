import { cn } from "@/lib/utils";
import type { PersonPresence } from "@/lib/person-presence";

// Single source of truth for presence colours. Semantic accents
// (emerald / amber / muted), mirroring the role-chip palette already
// used across settings, so they're intentionally not tokenized.
export const PRESENCE_DOT_CLASS: Record<PersonPresence, string> = {
  online: "bg-emerald-500",
  away: "bg-amber-500",
  offline: "bg-muted-foreground/50",
  // The phone's states (lib/person-presence.ts): red on a call, solid
  // grey off work, and grey with a line (below) on Do not disturb.
  on_call: "bg-red-500",
  off_work: "bg-muted-foreground",
  dnd: "bg-muted-foreground",
};

/**
 * A small presence dot. Used inline (e.g. the inbox Assign dropdown)
 * and, with `asAvatarBadge`-style positioning supplied via className,
 * layered onto an avatar. `label` powers the native title/aria for
 * the lightweight inline case; the roster wraps it in a real Tooltip.
 */
export function PresenceDot({
  status,
  label,
  className,
}: {
  status: PersonPresence;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-block size-2 shrink-0 rounded-full",
        PRESENCE_DOT_CLASS[status],
        className,
      )}
    >
      {status === "dnd" && (
        <span className="bg-background absolute inset-x-px top-1/2 h-px -translate-y-1/2 rounded-full" />
      )}
    </span>
  );
}
