/**
 * Pure helpers for the audited channel export (migration 160): CSV text
 * for a spreadsheet and a safe download name. No I/O.
 */
import { neutraliseFormula } from '@/lib/csv/build';

import type { ChannelExport } from './api';

const BOM = '﻿';

/** RFC 4180: quote a field with a comma, quote or line break; double quotes. */
function field(raw: string): string {
  const v = neutraliseFormula(raw);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 'YYYY-MM-DD HH:mm:ss' in the given IANA zone (UTC when absent or invalid). */
function formatTime(iso: string | null, timeZone?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
  } catch {
    return formatTime(iso);
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

export const EXPORT_CSV_HEADER = [
  'time',
  'thread',
  'reply to',
  'author',
  'body',
  'attachments',
  'edited at',
  'status',
] as const;

export function exportToCsv(
  exported: ChannelExport,
  opts: { timeZone?: string } = {}
): string {
  const lines: string[] = [EXPORT_CSV_HEADER.join(',')];
  for (const m of exported.messages) {
    const status = m.erasedAt ? 'erased' : m.deletedAt ? 'deleted' : '';
    const author =
      m.authorName ||
      (m.authorKind === 'system' ? 'System' : (m.authorId ?? ''));
    lines.push(
      [
        formatTime(m.createdAt, opts.timeZone),
        m.threadRootId ?? '',
        m.replyToId ?? '',
        author,
        m.body,
        m.attachments.map((a) => a.name).join('; '),
        formatTime(m.editedAt, opts.timeZone),
        status,
      ]
        .map(field)
        .join(',')
    );
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

const day = (v: string | null | undefined): string => {
  const m = v ? /^\d{4}-\d{2}-\d{2}/.exec(v) : null;
  return m ? m[0] : '';
};

/** 'chat-<channel>-<range>.csv'; ASCII letters, digits, '-' and '_' only. */
export function exportFileName(
  channelName: string | null,
  from?: string | null,
  to?: string | null
): string {
  const slug =
    (channelName ?? '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'channel';
  const f = day(from);
  const t = day(to);
  const range =
    f && t ? `${f}_to_${t}` : f ? `from_${f}` : t ? `until_${t}` : '';
  return `chat-${slug}${range ? `-${range}` : ''}.csv`;
}
