// Pure layout rules for the customer page (/contacts/[id]): which
// header actions a person gets and where they sit, and how a deal row
// reads. Kept here so the component stays a renderer.

import { formatCurrency } from '@/lib/currency';

import type { CustomerAccess } from './customer-access';

export type HeaderAction =
  'call' | 'whatsapp' | 'message' | 'template' | 'edit' | 'delete';

export interface HeaderActions {
  /** Always on the bar. */
  bar: HeaderAction[];
  /** On the bar from `sm` up; in the overflow menu on a phone. */
  secondary: HeaderAction[];
  /** Only ever in the overflow menu (destructive). */
  menu: HeaderAction[];
}

/** The header's actions for this person. Opening the WhatsApp chat is
 *  a read, so a viewer keeps it; everything else follows `access`. */
export function headerActions(access: CustomerAccess): HeaderActions {
  const bar: HeaderAction[] = [];
  if (access.call) bar.push('call');
  bar.push('whatsapp');
  if (access.send) bar.push('message');
  const secondary: HeaderAction[] = [];
  if (access.send) secondary.push('template');
  if (access.edit) secondary.push('edit');
  return { bar, secondary, menu: access.deleteContact ? ['delete'] : [] };
}

/** Whether the overflow menu has anything to show on a phone / from `sm` up. */
export function overflowItems(
  a: HeaderActions,
  compact: boolean
): HeaderAction[] {
  return compact ? [...a.secondary, ...a.menu] : a.menu;
}

export interface DealRowInput {
  id: string;
  title: string;
  value: number | null;
  currency?: string | null;
  status?: string | null;
  stage?: { name: string; color: string | null } | null;
}

export interface DealRow {
  id: string;
  title: string;
  stage: string | null;
  color: string | null;
  value: string;
  /** Null while open; the outcome once won or lost. */
  outcome: 'won' | 'lost' | null;
}

/** Open deals first, then the rest, each newest first as read. */
export function dealRows(
  deals: DealRowInput[],
  defaultCurrency: string
): DealRow[] {
  const rows: DealRow[] = deals.map((d) => ({
    id: d.id,
    title: d.title,
    stage: d.stage?.name ?? null,
    color: d.stage?.color ?? null,
    value: formatCurrency(d.value ?? 0, d.currency || defaultCurrency),
    outcome: d.status === 'won' || d.status === 'lost' ? d.status : null,
  }));
  return [...rows.filter((r) => !r.outcome), ...rows.filter((r) => r.outcome)];
}
