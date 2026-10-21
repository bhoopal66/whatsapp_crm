/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + mode-aware badge classes here so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-muted text-muted-foreground border-border',
  },
  PENDING: {
    label: 'Pending',
    classes: 'bg-warning-soft text-warning border-warning/30',
  },
  APPROVED: {
    label: 'Approved',
    classes: 'bg-success-soft text-success border-success/30',
  },
  REJECTED: {
    label: 'Rejected',
    classes: 'bg-destructive-soft text-destructive border-destructive/30',
  },
  PAUSED: {
    label: 'Paused',
    classes:
      'bg-orange-500/10 text-orange-700 border-orange-500/30 dark:text-orange-300',
  },
  DISABLED: {
    label: 'Disabled',
    classes: 'bg-destructive-soft text-destructive border-destructive/50',
  },
  IN_APPEAL: {
    label: 'In Appeal',
    classes: 'bg-info-soft text-info border-info/30',
  },
  PENDING_DELETION: {
    label: 'Pending Deletion',
    classes: 'bg-muted text-muted-foreground border-dashed border-border',
  },
};
