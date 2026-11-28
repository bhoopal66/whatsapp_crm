/**
 * checkSend: the send guard (`guard.ts`) on live state, server-only (call
 * with the service-role client). One call per outgoing message:
 *
 * - Loads state lazily, in the guard's rule order: recipient signals
 *   (334), the number's state (188's meta_number_state, its age from
 *   whatsapp_config.created_at), paused templates (188's
 *   meta_template_health), today's marketing count (188's
 *   meta_marketing_sent_today), and the marketing spend reservation (334's
 *   cap and ledger, scope `wa.marketing.daily`).
 * - Reads 188's `enforce` switch. Unreadable → treated as ON (fail closed,
 *   as the AI spend cap does when it cannot read its cap).
 * - Records every decision (send_protection_decision_record) with the
 *   `enforced` flag.
 * - While enforce is OFF (watch mode) the send always goes ahead: the log
 *   says what the guard would have done, and any spend it reserved is
 *   refunded at once.
 * - While enforce is ON a log failure turns an allowed MARKETING send into
 *   LOG_UNAVAILABLE (its reservation refunded); it never blocks a session
 *   reply or a utility / authentication template.
 *
 * A caller whose send then fails gives the spend back with
 * refundSendReservation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { spendDay } from '@/lib/ai/spend-cap';
import { normalizeStatus } from '../template-status-normalize';
import {
  canSend,
  GUARD_REASONS,
  type GuardContext,
  type GuardNumberState,
  type GuardReason,
  type SendRequest,
  type TemplateCategory,
} from './guard';
import { numberStateFromRow } from './state';

export const MARKETING_SPEND_SCOPE = 'wa.marketing.daily';

export type CheckSendInput = {
  accountId: string;
  /** The whatsapp_config the message goes out on. */
  configId: string;
  contactId: string;
  /** Price of a marketing template (micros); 0 when unknown. */
  costMicros?: number;
} & (
  | { kind: 'SESSION'; templateName?: string | null }
  | { kind: TemplateCategory; templateName: string }
);

export type SendReservation = {
  accountId: string;
  scope: typeof MARKETING_SPEND_SCOPE;
  /** The UTC day the database charged (send_protection_spend_add). */
  day: string;
  micros: number;
};

export type CheckSendResult = {
  allow: boolean;
  reason: GuardReason;
  deferUntil?: string;
  enforced: boolean;
  /** Held spend on an allowed, enforced marketing send. */
  reservation?: SendReservation;
};

type Row = Record<string, unknown>;

function firstRow(data: unknown): Row | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Row) : null;
}

async function rpcRow(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<Row | null> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed`);
  return firstRow(data);
}

const PAUSED_STATUSES: ReadonlySet<string> = new Set(['PAUSED', 'DISABLED']);
const DAY_MS = 86_400_000;

function guardContext(
  client: SupabaseClient,
  input: CheckSendInput,
  now: () => Date,
  hold: (r: SendReservation) => void
): GuardContext {
  const { accountId, configId } = input;
  return {
    now,
    async recipientSignals(contactId) {
      const row = await rpcRow(client, 'send_protection_recipient_signals', {
        p_account: accountId,
        p_contact: contactId,
      });
      if (!row) throw new Error('no recipient signals');
      return {
        optedOut: row.opted_out === true,
        sentWithoutReply: Number(row.sent_without_reply) || 0,
        failedDeliveries: Number(row.failed_deliveries) || 0,
      };
    },
    async numberState(): Promise<GuardNumberState> {
      const [state, config] = await Promise.all([
        client
          .from('meta_number_state')
          .select(
            'quality_rating, messaging_limit_tier, account_status, assessed_state, reasons'
          )
          .eq('config_id', configId)
          .eq('account_id', accountId)
          .maybeSingle(),
        client
          .from('whatsapp_config')
          .select('created_at')
          .eq('id', configId)
          .eq('account_id', accountId)
          .maybeSingle(),
      ]);
      if (state.error || config.error) throw new Error('number state failed');
      const s = numberStateFromRow(state.data);
      const created = Date.parse(String(config.data?.created_at ?? ''));
      return {
        qualityRating: s.qualityRating,
        messagingLimitTier: s.messagingLimitTier,
        accountStatus: s.accountStatus,
        // Unknown age counts as a new number (the smaller ramp share).
        numberAgeDays: Number.isFinite(created)
          ? Math.max(0, Math.floor((now().getTime() - created) / DAY_MS))
          : 0,
      };
    },
    async pausedTemplates() {
      const name = input.templateName;
      if (!name) return [];
      const { data, error } = await client
        .from('meta_template_health')
        .select('status, paused_until')
        .eq('account_id', accountId)
        .eq('template_name', name);
      if (error) throw new Error('template health failed');
      // Any language of the name paused counts: the send does not say which.
      const paused = ((data ?? []) as Row[]).some((r) => {
        const status = normalizeStatus(String(r.status ?? ''));
        const until = Date.parse(String(r.paused_until ?? ''));
        return (
          (status !== null && PAUSED_STATUSES.has(status)) ||
          (Number.isFinite(until) && until > now().getTime())
        );
      });
      return paused ? [name] : [];
    },
    async todayCounts() {
      const { data, error } = await client.rpc('meta_marketing_sent_today', {
        p_config: configId,
        p_day: now().toISOString().slice(0, 10),
      });
      if (error) throw new Error('marketing count failed');
      const sent = Number(data) || 0;
      // 188 counts (message, recipient) pairs: at least the new recipients.
      return { sentToday: sent, newRecipientsToday: sent };
    },
    async reserveMarketingSpend(micros) {
      const caps = await rpcRow(client, 'send_protection_caps_get', {
        p_account: accountId,
      });
      const raw = caps?.daily_marketing_spend_micros;
      // No cap: allowed and the ledger is never touched (spend-cap.ts).
      if (raw === null || raw === undefined) {
        return { allowed: true, release: async () => {} };
      }
      const row = await rpcRow(client, 'send_protection_spend_add', {
        p_account: accountId,
        p_scope: MARKETING_SPEND_SCOPE,
        p_micros: micros,
        p_hard_cap: Number(raw),
      });
      if (!row || typeof row.allowed !== 'boolean') {
        throw new Error('spend_add answered nothing');
      }
      if (!row.allowed) return { allowed: false, release: async () => {} };
      const reservation: SendReservation = {
        accountId,
        scope: MARKETING_SPEND_SCOPE,
        day: spendDay(row.day, now),
        micros,
      };
      hold(reservation);
      return {
        allowed: true,
        release: async () => {
          await refundSendReservation(client, reservation);
        },
      };
    },
  };
}

async function readEnforce(
  client: SupabaseClient,
  accountId: string
): Promise<boolean> {
  try {
    const row = await rpcRow(client, 'meta_protection_settings_get', {
      p_account: accountId,
    });
    return row?.enforce === true;
  } catch {
    return true;
  }
}

async function recordDecision(
  client: SupabaseClient,
  input: CheckSendInput,
  decision: 'ALLOW' | 'DENY' | 'DEFER',
  reason: GuardReason,
  enforced: boolean
): Promise<boolean> {
  try {
    const { error } = await client.rpc('send_protection_decision_record', {
      p_account: input.accountId,
      p_config: input.configId,
      p_template: input.templateName ?? null,
      p_contact: input.contactId,
      p_kind: input.kind,
      p_decision: decision,
      p_reason: reason,
      p_enforced: enforced,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function checkSend(
  client: SupabaseClient,
  input: CheckSendInput,
  now: () => Date = () => new Date()
): Promise<CheckSendResult> {
  const costMicros = input.costMicros ?? 0;
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
    throw new TypeError('costMicros must be a non-negative integer');
  }
  const enforced = await readEnforce(client, input.accountId);
  let held: SendReservation | null = null;
  const ctx = guardContext(client, input, now, (r) => {
    held = r;
  });
  const req: SendRequest =
    input.kind === 'SESSION'
      ? {
          kind: 'SESSION',
          contactId: input.contactId,
          template: input.templateName ?? null,
        }
      : {
          kind: 'TEMPLATE',
          contactId: input.contactId,
          template: input.templateName,
          category: input.kind,
          costMicros,
        };
  const d = await canSend(ctx, req);
  const reservation: SendReservation | null = d.allow ? held : null;
  const logged = await recordDecision(
    client,
    input,
    d.allow ? 'ALLOW' : d.deferUntil ? 'DEFER' : 'DENY',
    d.reason,
    enforced
  );

  if (!enforced) {
    // Watch mode: the send goes ahead whatever the guard said.
    await refundSendReservation(client, reservation);
    return { allow: true, reason: d.reason, enforced: false };
  }
  if (!logged && d.allow && input.kind === 'MARKETING') {
    await refundSendReservation(client, reservation);
    return {
      allow: false,
      reason: GUARD_REASONS.LOG_UNAVAILABLE,
      enforced: true,
    };
  }
  return {
    allow: d.allow,
    reason: d.reason,
    ...(d.deferUntil ? { deferUntil: d.deferUntil } : {}),
    enforced: true,
    ...(reservation ? { reservation } : {}),
  };
}

/** Gives a marketing reservation back (the send failed). Never throws. */
export async function refundSendReservation(
  client: SupabaseClient,
  reservation: SendReservation | null | undefined
): Promise<boolean> {
  if (!reservation || reservation.micros === 0) return true;
  try {
    const { error } = await client.rpc('send_protection_spend_refund', {
      p_account: reservation.accountId,
      p_scope: reservation.scope,
      p_day: reservation.day,
      p_micros: reservation.micros,
    });
    return !error;
  } catch {
    return false;
  }
}
