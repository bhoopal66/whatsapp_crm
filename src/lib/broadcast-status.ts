/**
 * Shared status badge config for broadcasts + recipients.
 *
 * Previously `statusConfig` was defined inline in both
 * /broadcasts/page.tsx and /broadcasts/[id]/page.tsx with slight
 * drift risk. One source of truth now.
 *
 * Badge shape: bg-<colour>/10 + text-<colour> + border-<colour>/20. The
 * translucent fills sit on both light and dark surfaces, and the text
 * colours are the mode-aware status tokens (text-info, text-warning,
 * text-destructive): a fixed text-*-400 was too faint to read on the
 * light theme. Neutral statuses use text-muted-foreground for the same
 * reason.
 */

import type { BroadcastStatus, RecipientStatus } from "@/types";

export interface StatusDisplay {
  label: string;
  classes: string;
  /**
   * Set true for statuses that should pulse in the UI to convey
   * "live / in-flight" — currently only `sending`.
   */
  pulse?: boolean;
}

export const broadcastStatusConfig: Record<BroadcastStatus, StatusDisplay> = {
  draft: {
    label: "draft",
    classes: "bg-slate-500/10 text-muted-foreground border-slate-500/20",
  },
  scheduled: {
    label: "scheduled",
    classes: "bg-info/10 text-info border-info/20",
  },
  sending: {
    label: "sending",
    classes: "bg-warning/10 text-warning border-warning/20",
    pulse: true,
  },
  sent: {
    label: "sent",
    classes: "bg-primary/10 text-primary border-primary/20",
  },
  failed: {
    label: "failed",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
  },
};

export const recipientStatusConfig: Record<RecipientStatus, StatusDisplay> = {
  pending: {
    label: "pending",
    classes: "bg-slate-500/10 text-muted-foreground border-slate-500/20",
  },
  sent: {
    label: "sent",
    classes: "bg-info/10 text-info border-info/20",
  },
  delivered: {
    label: "delivered",
    classes: "bg-primary/10 text-primary border-primary/20",
  },
  read: {
    label: "read",
    classes: "bg-primary/10 text-primary border-primary/20",
  },
  replied: {
    label: "replied",
    classes:
      "bg-violet-500/10 text-violet-700 border-violet-500/20 dark:text-violet-300",
  },
  failed: {
    label: "failed",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
  },
};

/**
 * Tolerant lookup — callers often have a generic string status
 * coming from Supabase. Falls back to the "draft" / "pending"
 * entry so the UI never crashes on an unknown value.
 */
export function getBroadcastStatus(status: string): StatusDisplay {
  return (
    broadcastStatusConfig[status as BroadcastStatus] ??
    broadcastStatusConfig.draft
  );
}

export function getRecipientStatus(status: string): StatusDisplay {
  return (
    recipientStatusConfig[status as RecipientStatus] ??
    recipientStatusConfig.pending
  );
}
