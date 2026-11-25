import type { Broadcast } from '@/types';

// ------------------------------------------------------------
// The home "Campaigns" card: what is sending or scheduled now, and one
// line about the last week's sent campaigns. Pure; the card reads the
// rows through the browser client (RLS keeps broadcasts to admins).
// ------------------------------------------------------------

export const CAMPAIGN_COLUMNS =
  'id, name, status, scheduled_at, total_recipients, sent_count, delivered_count, read_count, failed_count, created_at';

export type CampaignRow = Pick<
  Broadcast,
  | 'id'
  | 'name'
  | 'status'
  | 'scheduled_at'
  | 'total_recipients'
  | 'sent_count'
  | 'delivered_count'
  | 'read_count'
  | 'failed_count'
  | 'created_at'
>;

/** How many in-flight campaigns the card lists. */
export const IN_FLIGHT_LIMIT = 5;
/** The summary line looks back this far. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const n = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

export interface CampaignProgress {
  sent: number;
  total: number;
  /** 0–100, for the bar's width. */
  percent: number;
}

/** A sending campaign's "sent of total". */
export function campaignProgress(
  row: Pick<CampaignRow, 'sent_count' | 'total_recipients'>
): CampaignProgress {
  const total = n(row.total_recipients);
  const sent = n(row.sent_count);
  const percent =
    total === 0 ? 0 : Math.min(100, Math.round((sent / total) * 100));
  return { sent, total, percent };
}

/** Sending first, then the soonest scheduled; unscheduled last. */
export function sortInFlight<T extends CampaignRow>(rows: readonly T[]): T[] {
  const at = (r: T) => {
    const ms = r.scheduled_at ? Date.parse(r.scheduled_at) : NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  return [...rows].sort(
    (a, b) =>
      Number(b.status === 'sending') - Number(a.status === 'sending') ||
      at(a) - at(b)
  );
}

export interface WeekSummary {
  campaigns: number;
  sent: number;
  /** Whole percent of sent messages delivered; null with nothing sent. */
  deliveredPct: number | null;
  readPct: number | null;
}

/**
 * The week's finished campaigns: every 'sent' one (a fully failed one still
 * counts, as before) and a 'stopped' one only if it got some messages out;
 * one stopped before its first send is not a campaign that went out.
 */
export function weekCampaigns<
  T extends { status: string; sent_count: number | null },
>(rows: readonly T[]): T[] {
  return rows.filter(
    (r) =>
      r.status === 'sent' || (r.status === 'stopped' && n(r.sent_count) > 0)
  );
}

/** "5 sent this week · 82% delivered · 31% read". */
export function weekSummary(
  rows: readonly Pick<
    CampaignRow,
    'sent_count' | 'delivered_count' | 'read_count'
  >[]
): WeekSummary {
  let sent = 0;
  let delivered = 0;
  let read = 0;
  for (const r of rows) {
    sent += n(r.sent_count);
    delivered += n(r.delivered_count);
    read += n(r.read_count);
  }
  const pct = (v: number) =>
    sent === 0 ? null : Math.min(100, Math.round((v / sent) * 100));
  return {
    campaigns: rows.length,
    sent,
    deliveredPct: pct(delivered),
    readPct: pct(read),
  };
}

export type ScheduleDay = 'past' | 'today' | 'tomorrow' | 'week' | 'later';

/**
 * Which words a scheduled time takes, by calendar day in the browser's
 * zone: "Today 18:00", "Tomorrow 09:00", "Thu 09:00" within a week,
 * else a date. A time already passed is 'past' (the cron has yet to
 * pick it up).
 */
export function scheduleDay(at: Date, now: Date): ScheduleDay {
  if (at.getTime() < now.getTime()) return 'past';
  const day = (d: Date) =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const diff = day(at) - day(now);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}
