// ============================================================
// The Team activity CSV export (owner only): one row per person and
// one per number, for the range the page shows. Headers are plain
// English constants; the cells are the report's own figures, never a
// message text or a customer. Pure: `buildCsv` does the quoting and
// the formula neutralising.
// ============================================================

import { buildCsv, type CsvCell } from '@/lib/csv/build';

import {
  isListedSender,
  matureReplyRate,
  numberDisplayName,
  type NumberActivity,
  type SenderActivity,
  type TeamActivityReport,
} from './report';

export const EXPORT_TABLES = ['people', 'numbers'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

export function isExportTable(value: unknown): value is ExportTable {
  return (
    typeof value === 'string' &&
    (EXPORT_TABLES as readonly string[]).includes(value)
  );
}

export interface ExportPeriod {
  from: string;
  to: string;
  tz: string;
}

const PERIOD_HEADER = ['Period start', 'Period end', 'Time zone'] as const;

export const PEOPLE_HEADER: readonly string[] = [
  ...PERIOD_HEADER,
  'Name',
  'Email',
  'Role',
  'Sender type',
  'Messages sent',
  'Conversations',
  'Delivered',
  'Read',
  'Failed',
  'Failed on phone numbers',
  'Failed on official number',
  'Active days',
  'Chats started',
  'New contacts',
  'Chats older than a day',
  'Of those, no reply',
  'Reply rate %',
  'Awaiting reply (under a day)',
  'Links in first message',
  'Similar openers',
  'Night starts',
  'Most starts in a day',
  'Days at limit',
  'Chats started today',
  'Most starts in 10 minutes',
  'Chats chased (new customers)',
  'Chats chased (existing customers)',
  'Longest unanswered run',
  'Replies to customers',
  'Median response (minutes)',
  'Customers waiting now',
  'Waiting under 24 hours',
  'Waiting 1 to 7 days',
  'Broadcasts',
  'Broadcast messages sent',
  'Broadcast messages failed',
  'Broadcast replies',
];

export const NUMBERS_HEADER: readonly string[] = [
  ...PERIOD_HEADER,
  'Number',
  'Provider',
  'Number type',
  'Status',
  'Primary',
  'Age (days)',
  'Warming up',
  'Daily new-chat limit',
  'Messages sent',
  'Messages received',
  'Conversations',
  'Delivered',
  'Read',
  'Failed',
  'Chats started',
  'New contacts',
  'No reply',
  'Chats older than a day',
  'Of those, no reply',
  'Reply rate %',
  'Awaiting reply (under a day)',
  'Links in first message',
  'Identical openers',
  'Night starts',
  'Most starts in a day',
  'Days at limit',
  'Chats started today',
  'Most starts in 10 minutes',
  'Messages past the unanswered limit',
];

const SENDER_TYPE: Record<SenderActivity['kind'], string> = {
  person: 'Person',
  api: 'API',
  bot: 'Bot',
};

function senderName(s: SenderActivity): string {
  if (s.kind === 'api') return s.name || 'API and integrations';
  if (s.kind === 'bot') return s.name || 'Bots';
  return s.name || s.email || '';
}

function periodCells(p: ExportPeriod): CsvCell[] {
  return [p.from, p.to, p.tz];
}

export function peopleRows(
  report: TeamActivityReport,
  period: ExportPeriod
): CsvCell[][] {
  return report.senders.filter(isListedSender).map((s) => {
    const person = s.kind === 'person';
    return [
      ...periodCells(period),
      senderName(s),
      person ? s.email : null,
      person ? s.role : null,
      SENDER_TYPE[s.kind],
      s.messagesSent,
      s.conversations,
      s.delivered,
      s.read,
      s.failed,
      s.failedPhone,
      s.failedOfficial,
      s.activeDays,
      s.chatsStarted,
      s.newContacts,
      s.matureStarted,
      s.matureNoReply,
      matureReplyRate(s),
      s.pendingReply,
      s.linksFirst,
      s.similarOpeners,
      s.nightStarts,
      s.peakDay,
      s.daysAtLimit,
      s.todayStarts,
      s.burst10min,
      s.chaseNew,
      s.chaseExisting,
      s.longestChase,
      // The SQL sends no replies or response times for API and bots (D9).
      person ? s.replies : null,
      person ? s.responseMedianMin : null,
      s.waiting,
      s.waitingRecent,
      s.waitingOlder,
      s.broadcasts,
      s.broadcastSent,
      s.broadcastFailed,
      s.broadcastReplied,
    ];
  });
}

function providerName(p: NumberActivity['provider']): string {
  switch (p) {
    case 'whapi':
      return 'Whapi';
    case 'meta':
      return 'Meta Cloud API';
    case 'openwa':
      return 'OpenWA';
    default:
      return '';
  }
}

export function numberRows(
  report: TeamActivityReport,
  period: ExportPeriod
): CsvCell[][] {
  return report.numbers.map((n) => [
    ...periodCells(period),
    numberDisplayName(n) ?? '',
    providerName(n.provider),
    n.kind === 'phone' ? 'Phone' : 'Official',
    n.status,
    n.isPrimary ? 'Yes' : 'No',
    n.ageDays,
    n.warmingUp ? 'Yes' : 'No',
    n.effectiveDailyLimit,
    n.messagesSent,
    n.received,
    n.conversations,
    n.delivered,
    n.read,
    n.failed,
    n.chatsStarted,
    n.newContacts,
    n.noReply,
    n.matureStarted,
    n.matureNoReply,
    matureReplyRate(n),
    n.pendingReply,
    n.linksFirst,
    n.identicalOpeners,
    n.nightStarts,
    n.peakDay,
    n.daysAtLimit,
    n.todayStarts,
    n.burst10min,
    n.unansweredOverLimit,
  ]);
}

/** The CSV text for one table of the report. */
export function teamActivityCsv(
  report: TeamActivityReport,
  table: ExportTable,
  period: ExportPeriod
): string {
  return table === 'people'
    ? buildCsv(PEOPLE_HEADER, peopleRows(report, period))
    : buildCsv(NUMBERS_HEADER, numberRows(report, period));
}
