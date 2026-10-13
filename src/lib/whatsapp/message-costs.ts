import type { SupabaseClient } from '@supabase/supabase-js';

import type { RawMetaStatus } from './meta-webhook';

/**
 * Meta Cloud API per-message cost ledger — the app side of migration
 * 051.
 *
 * The logic (rate card, market resolution, the 2026-10-01 service
 * quota, Meta's `billable` override) lives in the
 * `record_whatsapp_message_cost` Postgres function; this module is the
 * thin adapter the webhook calls, plus the pure shaping the report
 * endpoint and the settings panel share.
 *
 * Whapi is never costed: a Whapi channel is a flat gateway
 * subscription, and its callbacks carry no `pricing` object to cost
 * from. Only the Meta webhook route calls into here.
 */

/** Meta bills in USD; the dirham is pegged, so AED is a fixed multiple. */
export const USD_AED_PEG = 3.6725;

/**
 * The first 1,000 delivered service messages per number per month are
 * free from 2026-10-01. Mirrors the constant in the SQL function and
 * the `whatsapp_service_quota` view.
 */
export const SERVICE_FREE_TIER = 1000;

/**
 * The calendar month a delivery belongs to for the free-tier count is
 * the WABA's timezone, not the server's. `WHATSAPP_BILLING_TIMEZONE`
 * overrides the Gulf default when the business account lives
 * elsewhere.
 */
export function billingTimezone(): string {
  return process.env.WHATSAPP_BILLING_TIMEZONE?.trim() || 'Asia/Dubai';
}

export interface RecordCostArgs {
  accountId: string;
  /** `metadata.phone_number_id` — the Meta number that sent the message. */
  phoneNumberId: string;
  /** Raw `statuses[]` entries, verbatim from the callback. */
  statuses: RawMetaStatus[];
}

export interface RecordCostResult {
  ok: boolean;
  duplicate?: boolean;
  error?: { code: string; message: string };
}

/**
 * Feed every delivery receipt of one callback to the ledger.
 *
 * Fails OPEN by contract: a costing failure is logged and swallowed,
 * never thrown. The caller is the webhook's `after()` block, and an
 * error escaping it would be caught and logged anyway — but the
 * contract is spelled out here so nobody moves this call ahead of the
 * message processing and turns a rate-card problem into a lost
 * inbound message. Runs statuses sequentially so the service-quota
 * count inside the function sees earlier receipts of the same batch.
 *
 * Pass the service-role client: the function is granted to
 * `service_role` only.
 */
export async function recordMetaMessageCosts(
  db: SupabaseClient,
  args: RecordCostArgs
): Promise<RecordCostResult[]> {
  return recordEach(db, args, (status, timezone) =>
    db.rpc('record_whatsapp_message_cost', {
      p_account_id: args.accountId,
      p_phone_number_id: args.phoneNumberId,
      p_status: status,
      p_timezone: timezone,
    })
  );
}

/**
 * The receipts of group sends (deal rooms, `recipient_type: 'group'`),
 * one at a time, through `deal_room_record_cost` (migration 100): the
 * ledger costs each member's delivery at that member's market, and only
 * a receipt the ledger had not seen moves the message's `category` and
 * `recipients_billed`, so a redelivery counts once. Fails open, exactly
 * like `recordMetaMessageCosts`; the same service-role client.
 */
export async function recordGroupMessageCosts(
  db: SupabaseClient,
  args: RecordCostArgs
): Promise<RecordCostResult[]> {
  return recordEach(db, args, (status, timezone) =>
    db.rpc('deal_room_record_cost', {
      p_account: args.accountId,
      p_phone_number_id: args.phoneNumberId,
      p_status: status,
      p_timezone: timezone,
    })
  );
}

async function recordEach(
  db: SupabaseClient,
  args: RecordCostArgs,
  call: (
    status: RawMetaStatus,
    timezone: string
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<RecordCostResult[]> {
  const results: RecordCostResult[] = [];
  if (!args.accountId || !args.phoneNumberId) return results;

  const timezone = billingTimezone();

  for (const status of args.statuses) {
    try {
      const { data, error } = await call(status, timezone);
      if (error) {
        console.error(
          `[message-costs] ledger write failed for ${status.id}:`,
          error
        );
        results.push({
          ok: false,
          error: { code: 'COST_LEDGER_ERROR', message: error.message },
        });
        continue;
      }
      const res = data as {
        ok?: boolean;
        data?: { duplicate?: boolean };
        error?: { code?: string; message?: string };
      } | null;
      if (!res?.ok) {
        console.warn(
          `[message-costs] receipt rejected for ${status.id}:`,
          res?.error
        );
        results.push({
          ok: false,
          error: {
            code: res?.error?.code ?? 'BAD_STATUS',
            message: res?.error?.message ?? 'rejected',
          },
        });
        continue;
      }
      results.push({ ok: true, duplicate: res.data?.duplicate === true });
    } catch (err) {
      // Fail open — the cost layer never blocks message flow.
      console.error(
        `[message-costs] ledger write threw for ${status.id}:`,
        err
      );
      results.push({
        ok: false,
        error: { code: 'COST_LEDGER_ERROR', message: 'swallowed; see logs' },
      });
    }
  }
  return results;
}

// ============================================================
// Report shaping (pure) — shared by GET /api/whatsapp/costs and tests.
// ============================================================

/** One row of the `whatsapp_cost_monthly` view. */
export interface MonthlyCostRow {
  month: string; // YYYY-MM-DD, first of the month
  phone_number_id: string;
  recipient_market: string;
  category: string | null;
  delivered: number;
  billed: number;
  quota_free: number;
  unknown_rate: number;
  cost_usd: number | string | null;
}

/** One row of the `whatsapp_service_quota` view. */
export interface ServiceQuotaRow {
  phone_number_id: string;
  month: string;
  service_delivered: number;
  free_remaining: number;
}

export interface CostBucket {
  delivered: number;
  billed: number;
  quota_free: number;
  unknown_rate: number;
  cost_usd: number;
}

export interface CostReport {
  /** Months covered, oldest → newest, as YYYY-MM-DD (first of month). */
  months: string[];
  totals: CostBucket;
  /**
   * The current billing month on its own — the headline tiles.
   *
   * `service_delivered` is the free-tier figure and comes from the
   * quota view, NOT from `quota_free`: a service message is free
   * outright before 2026-10-01, and the ledger only sets `quota_free`
   * once the 1,000-message allowance is what makes it free. Reading
   * `quota_free` here showed a flat zero for every account until that
   * date while the per-number rows below it counted normally.
   */
  current: CostBucket & {
    month: string;
    service_delivered: number;
    service_free_remaining: number;
  };
  by_month: Array<
    { month: string } & CostBucket & { by_category: Record<string, number> }
  >;
  by_category: Array<{ category: string } & CostBucket>;
  by_market: Array<{ market: string } & CostBucket>;
  by_number: Array<
    { phone_number_id: string; label: string | null } & CostBucket & {
        service_delivered: number;
        free_remaining: number;
      }
  >;
  usd_aed_peg: number;
}

function emptyBucket(): CostBucket {
  return {
    delivered: 0,
    billed: 0,
    quota_free: 0,
    unknown_rate: 0,
    cost_usd: 0,
  };
}

function add(into: CostBucket, row: MonthlyCostRow) {
  into.delivered += Number(row.delivered) || 0;
  into.billed += Number(row.billed) || 0;
  into.quota_free += Number(row.quota_free) || 0;
  into.unknown_rate += Number(row.unknown_rate) || 0;
  // PostgREST returns NUMERIC as a string; NULL means "unknown rate"
  // and contributes nothing — the unknown_rate counter carries it.
  into.cost_usd += row.cost_usd == null ? 0 : Number(row.cost_usd) || 0;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function finish<T extends CostBucket>(b: T): T {
  b.cost_usd = round6(b.cost_usd);
  return b;
}

/**
 * First-of-month keys for the last `n` months ending at `now`, oldest
 * first. "Now" is read in the billing timezone so that the current
 * month agrees with the `billing_month` the ledger stamped — for a few
 * hours around midnight on the 1st, UTC and the Gulf disagree on which
 * month it is.
 */
export function lastNMonthKeys(
  n: number,
  now: Date = new Date(),
  timezone: string = billingTimezone()
): string[] {
  const keys: string[] = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(now);
    const py = Number(parts.find((p) => p.type === 'year')?.value);
    const pm = Number(parts.find((p) => p.type === 'month')?.value);
    if (Number.isFinite(py) && Number.isFinite(pm)) {
      y = py;
      m = pm - 1;
    }
  } catch {
    // Unknown timezone name — fall back to UTC rather than failing the
    // report over a misspelt env var.
  }
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Fold the two view outputs into one response. `labels` names each
 * Meta number (the `whatsapp_config.label` an admin gave it) so the
 * panel can say "Marketing number" rather than a numeric id.
 */
export function buildCostReport(args: {
  monthly: MonthlyCostRow[];
  quota: ServiceQuotaRow[];
  months: string[];
  labels?: Record<string, string | null>;
}): CostReport {
  const { monthly, quota, months } = args;
  const labels = args.labels ?? {};
  const currentMonth = months[months.length - 1];

  const totals = emptyBucket();
  const current = {
    month: currentMonth,
    ...emptyBucket(),
    service_delivered: 0,
    service_free_remaining: 0,
  };
  const byMonth = new Map<
    string,
    { month: string } & CostBucket & { by_category: Record<string, number> }
  >();
  for (const month of months) {
    byMonth.set(month, { month, ...emptyBucket(), by_category: {} });
  }
  const byCategory = new Map<string, { category: string } & CostBucket>();
  const byMarket = new Map<string, { market: string } & CostBucket>();
  const byNumber = new Map<string, CostReport['by_number'][number]>();

  for (const row of monthly) {
    const monthBucket = byMonth.get(row.month);
    // Rows outside the requested window (the query is bounded, but a
    // clock skew between server and DB could hand back one more) are
    // ignored rather than mis-bucketed.
    if (!monthBucket) continue;

    add(totals, row);
    add(monthBucket, row);
    if (row.month === currentMonth) add(current, row);

    const category = row.category ?? 'service';
    const cost = row.cost_usd == null ? 0 : Number(row.cost_usd) || 0;
    monthBucket.by_category[category] = round6(
      (monthBucket.by_category[category] ?? 0) + cost
    );

    const cat = byCategory.get(category) ?? { category, ...emptyBucket() };
    add(cat, row);
    byCategory.set(category, cat);

    const mkt = byMarket.get(row.recipient_market) ?? {
      market: row.recipient_market,
      ...emptyBucket(),
    };
    add(mkt, row);
    byMarket.set(row.recipient_market, mkt);

    const num = byNumber.get(row.phone_number_id) ?? {
      phone_number_id: row.phone_number_id,
      label: labels[row.phone_number_id] ?? null,
      ...emptyBucket(),
      service_delivered: 0,
      free_remaining: SERVICE_FREE_TIER,
    };
    add(num, row);
    byNumber.set(row.phone_number_id, num);
  }

  // The free-tier position is a current-month figure per number.
  for (const q of quota) {
    if (q.month !== currentMonth) continue;
    const num = byNumber.get(q.phone_number_id) ?? {
      phone_number_id: q.phone_number_id,
      label: labels[q.phone_number_id] ?? null,
      ...emptyBucket(),
      service_delivered: 0,
      free_remaining: SERVICE_FREE_TIER,
    };
    num.service_delivered = Number(q.service_delivered) || 0;
    num.free_remaining = Number(q.free_remaining) || 0;
    byNumber.set(q.phone_number_id, num);
    // The allowance is per number, so the account-wide tile is the sum
    // of each number's position, not a single 1,000.
    current.service_delivered += num.service_delivered;
    current.service_free_remaining += num.free_remaining;
  }

  const desc = (a: CostBucket, b: CostBucket) =>
    b.cost_usd - a.cost_usd || b.delivered - a.delivered;

  return {
    months,
    totals: finish(totals),
    current: finish(current),
    by_month: [...byMonth.values()].map(finish),
    by_category: [...byCategory.values()].map(finish).sort(desc),
    by_market: [...byMarket.values()].map(finish).sort(desc),
    by_number: [...byNumber.values()].map(finish).sort(desc),
    usd_aed_peg: USD_AED_PEG,
  };
}

// ============================================================
// Category presentation (pure) — shared by the settings panel and
// tests. It lives here rather than in the component because the test
// environment is `node` with no DOM, so a component cannot be mounted
// to check it.
// ============================================================

/**
 * The categories the settings panel knows how to name and colour, in
 * the order it draws them. Mirrors the `Settings.costs.category.*`
 * message keys and the CHECK constraint on `whatsapp_rate_card`.
 */
export const KNOWN_CATEGORIES = [
  'marketing',
  'marketing_lite',
  'utility',
  'authentication',
  'authentication_international',
  'service',
  'referral_conversion',
] as const;

/**
 * Every category present in the report, known ones first in display
 * order, then anything unrecognised.
 *
 * `whatsapp_message_costs.category` is unconstrained text fed straight
 * from Meta's payload, so it can hold a value this build has never
 * heard of — a pre-per-message `business_initiated`, or a category
 * Meta introduces later. Restricting the stacked chart to the known
 * list dropped that spend from the bars while leaving it in the
 * headline total, so the chart quietly disagreed with the tile above
 * it. Unrecognised categories are kept, at the end.
 */
export function orderedCategories(
  byCategory: Array<{ category: string }>
): string[] {
  const present = new Set(byCategory.map((c) => c.category));
  const known = KNOWN_CATEGORIES.filter((c) => present.has(c)) as string[];
  const rest = byCategory
    .map((c) => c.category)
    .filter((c) => !(KNOWN_CATEGORIES as readonly string[]).includes(c));
  return [...known, ...new Set(rest)];
}

/**
 * A readable label for a category with no translation: `service` is
 * named in `messages/*.json`, `business_initiated` is not, and showing
 * the raw message key to an admin is worse than title-casing it.
 */
export function humanizeCategory(category: string): string {
  return category.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}
