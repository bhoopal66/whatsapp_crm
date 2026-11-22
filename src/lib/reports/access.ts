// ============================================================
// Who opens which report (migration 255).
//
// A report is opened either by role (the funnel: owners and admins) or
// by a per-person grant the owner gives (`report_access`, today only
// 'chat_tags'; the owner always has it). `report_my_access()` answers
// the caller's keys. This module parses those answers and lists the
// landing's entries; the SQL and the layouts are the boundary. Pure.
// ============================================================

import {
  canEditSettings,
  isBankGuest,
  canManageReportAccess,
  type AccountRole,
} from '@/lib/auth/roles';

/** Pinned to 255's `report_access_report_key_check` by access.test.ts. */
export const REPORT_KEYS = ['chat_tags'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(value: unknown): value is ReportKey {
  return (
    typeof value === 'string' &&
    (REPORT_KEYS as readonly string[]).includes(value)
  );
}

/** `report_my_access()`'s text[]: known keys only, deduped. */
export function parseReportKeys(raw: unknown): ReportKey[] {
  if (!Array.isArray(raw)) return [];
  return REPORT_KEYS.filter((k) => raw.includes(k));
}

export interface ReportAccessPerson {
  userId: string;
  name: string;
  role: string;
  granted: boolean;
  grantedAt: string | null;
}

/** `report_access_list()`'s jsonb array, tolerating bad rows. */
export function parseReportAccessList(raw: unknown): ReportAccessPerson[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportAccessPerson[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    if (typeof o.user_id !== 'string' || !o.user_id) continue;
    out.push({
      userId: o.user_id,
      name: typeof o.name === 'string' ? o.name : '',
      role: typeof o.role === 'string' ? o.role : '',
      granted: o.granted === true,
      grantedAt: typeof o.granted_at === 'string' ? o.granted_at : null,
    });
  }
  return out;
}

/** The reports the landing lists. */
export type ReportEntryKey = 'funnel' | 'chat_tags';

export interface ReportEntry {
  key: ReportEntryKey;
  href: string;
}

const ENTRIES: Record<ReportEntryKey, ReportEntry> = {
  funnel: { key: 'funnel', href: '/reports/funnel' },
  chat_tags: { key: 'chat_tags', href: '/reports/tags' },
};

/**
 * The landing's entries for a role and the caller's report keys: the
 * funnel for admin and up, the chat tag report for the owner or a
 * grantee. A bank guest gets nothing.
 */
export function reportsFor(
  role: AccountRole,
  keys: readonly string[]
): ReportEntry[] {
  if (isBankGuest(role)) return [];
  const out: ReportEntry[] = [];
  if (canEditSettings(role)) out.push(ENTRIES.funnel);
  if (canManageReportAccess(role) || keys.includes('chat_tags'))
    out.push(ENTRIES.chat_tags);
  return out;
}
