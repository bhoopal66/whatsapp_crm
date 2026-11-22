// ============================================================
// The dashboard CSV export (owner only): the home screen's figures as
// rows of (section, metric, period, value). Only counts, averages and
// the admin-defined stage names: never a message, a customer's name or
// a phone number.
//
// The home screen computes its windows in the browser's local time;
// the export runs on the server, so the same windows are computed here
// in an explicit zone (`dashboardWindows`). Pure: no I/O.
// ============================================================

import { buildCsv, type CsvCell } from '@/lib/csv/build';
import type { WeekSummary } from '@/lib/dashboard/home/campaigns';
import type { Glance } from '@/lib/team-activity/glance';
import { zonedDayStart } from '@/lib/team-activity/range';

import { DOW_SHORT_MON_FIRST } from './date-utils';
import type {
  ConversationsSeriesPoint,
  PipelineStageSlice,
  ResponseTimeSummary,
} from './types';

/** The messages chart's default range on the home screen. */
export const MESSAGES_DAYS = 30;
/** The response-time card looks back two weeks. */
export const RESPONSE_DAYS = 14;

export const DASHBOARD_HEADER: readonly string[] = [
  'Section',
  'Metric',
  'Period',
  'Value',
];

/** YYYY-MM-DD of `instant` in `timeZone`. */
export function zonedDayKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 0 = Monday … 6 = Sunday, for `instant` in `timeZone`. */
export function zonedMondayIndex(instant: Date, timeZone: string): number {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(instant);
  const i = DOW_SHORT_MON_FIRST.indexOf(
    day as (typeof DOW_SHORT_MON_FIRST)[number]
  );
  return i < 0 ? 0 : i;
}

export interface DashboardWindows {
  /** Start of the messages window (MESSAGES_DAYS local days, today included). */
  messagesSince: Date;
  /** Every local day of that window, oldest first. */
  messageDays: string[];
  responseSince: Date;
  thisWeekStart: Date;
  lastWeekStart: Date;
}

/** The home screen's windows, computed in `timeZone`. */
export function dashboardWindows(
  now: Date,
  timeZone: string
): DashboardWindows {
  const messageDays: string[] = [];
  for (let i = MESSAGES_DAYS - 1; i >= 0; i--) {
    // Noon of each local day, so the key never slips across a DST edge.
    const start = zonedDayStart(now, timeZone, i);
    messageDays.push(
      zonedDayKey(new Date(start.getTime() + 12 * 3_600_000), timeZone)
    );
  }
  const monday = zonedMondayIndex(now, timeZone);
  return {
    messagesSince: zonedDayStart(now, timeZone, MESSAGES_DAYS - 1),
    messageDays,
    responseSince: zonedDayStart(now, timeZone, RESPONSE_DAYS - 1),
    thisWeekStart: zonedDayStart(now, timeZone, monday),
    lastWeekStart: zonedDayStart(now, timeZone, monday + 7),
  };
}

export interface NumberCounts {
  total: number;
  connected: number;
  disconnected: number;
  unknown: number;
}

export interface DashboardFigures {
  tz: string;
  /** Today's date in `tz`. */
  today: string;
  messages: ConversationsSeriesPoint[];
  responseTime: ResponseTimeSummary;
  pipeline: PipelineStageSlice[];
  campaigns: { week: WeekSummary; inFlight: number };
  numbers: NumberCounts;
  /** Today's team activity; null when it could not be read. */
  team: Glance | null;
}

const round1 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10) / 10;

/** The rows of the CSV, section by section in the screen's order. */
export function dashboardRows(f: DashboardFigures): CsvCell[][] {
  const rows: CsvCell[][] = [];
  const add = (
    section: string,
    metric: string,
    period: string,
    value: CsvCell
  ) => rows.push([section, metric, period, value]);

  const today = `Today (${f.today})`;
  add('Export', 'Time zone', '', f.tz);

  if (f.team) {
    const s = 'Team activity';
    add(s, 'New chats started', today, f.team.todayNew);
    add(s, 'Chats older than a day', today, f.team.reply?.total ?? null);
    add(s, 'Of those, written back', today, f.team.reply?.replied ?? null);
    add(s, 'Reply rate %', today, f.team.reply?.percent ?? null);
    add(s, 'Awaiting reply (under a day)', today, f.team.pending);
    add(s, 'Customers waiting (under 24 hours)', 'Now', f.team.waitingRecent);
    add(s, 'Of those, unassigned', 'Now', f.team.waitingUnassignedRecent);
  }

  {
    const s = 'WhatsApp numbers';
    add(s, 'Numbers', 'Now', f.numbers.total);
    add(s, 'Connected', 'Now', f.numbers.connected);
    add(s, 'Disconnected', 'Now', f.numbers.disconnected);
    add(s, 'Status unknown', 'Now', f.numbers.unknown);
  }

  {
    const s = 'Campaigns';
    add(s, 'Sending or scheduled', 'Now', f.campaigns.inFlight);
    const week = 'Last 7 days';
    add(s, 'Campaigns sent', week, f.campaigns.week.campaigns);
    add(s, 'Messages sent', week, f.campaigns.week.sent);
    add(s, 'Delivered %', week, f.campaigns.week.deliveredPct);
    add(s, 'Read %', week, f.campaigns.week.readPct);
  }

  {
    const s = 'Messages';
    const first = f.messages[0]?.day;
    const last = f.messages[f.messages.length - 1]?.day;
    const span =
      first && last
        ? `Last ${f.messages.length} days (${first} to ${last})`
        : `Last ${f.messages.length} days`;
    let incoming = 0;
    let outgoing = 0;
    for (const p of f.messages) {
      incoming += p.incoming;
      outgoing += p.outgoing;
    }
    add(s, 'Incoming messages', span, incoming);
    add(s, 'Outgoing messages', span, outgoing);
    for (const p of f.messages) {
      add(s, 'Incoming messages', p.day, p.incoming);
      add(s, 'Outgoing messages', p.day, p.outgoing);
    }
  }

  {
    const s = 'Pipeline (open deals)';
    let count = 0;
    let value = 0;
    for (const st of f.pipeline) {
      count += st.dealCount;
      value += st.totalValue;
      add(s, `Deals in ${st.name}`, 'Now', st.dealCount);
      add(s, `Value in ${st.name}`, 'Now', st.totalValue);
    }
    add(s, 'Open deals', 'Now', count);
    add(s, 'Open deal value', 'Now', value);
  }

  {
    const s = 'First response time (minutes)';
    add(s, 'Average', 'This week', round1(f.responseTime.thisWeekAvg));
    add(s, 'Average', 'Last week', round1(f.responseTime.lastWeekAvg));
    const window = `Last ${RESPONSE_DAYS} days`;
    for (const b of f.responseTime.buckets) {
      const day = DOW_SHORT_MON_FIRST[b.dow] ?? String(b.dow);
      add(s, `Average on ${day}`, window, round1(b.avgMinutes));
      add(s, `Replies measured on ${day}`, window, b.samples);
    }
  }

  return rows;
}

export function dashboardCsv(f: DashboardFigures): string {
  return buildCsv(DASHBOARD_HEADER, dashboardRows(f));
}
