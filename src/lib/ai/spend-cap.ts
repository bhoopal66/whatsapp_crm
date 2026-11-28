/**
 * Daily AI spend cap (migration 334, scope `ai.daily`), in integer micros.
 * Server-only: call with the service-role client.
 *
 * - No AI cap set (send_protection_caps_get → NULL) → allowed, the ledger
 *   is never touched.
 * - A cap set → one atomic send_protection_spend_add; a refusal denies.
 * - Fails CLOSED: a store error on the ledger, or on reading the cap
 *   (we cannot tell whether a cap is set), denies.
 */

/** The slice of the Supabase client this module uses. */
export type SpendRpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

export type AiSpendDecision = {
  allowed: boolean;
  /** Set when a cap applied and the store answered. */
  totalMicros?: number;
  /** The store failed and the answer is a fail-closed deny. */
  degraded?: true;
  /** What to pass to refundAiSpend; null when nothing was held. */
  reservation: AiSpendReservation | null;
};

export type AiSpendReservation = {
  accountId: string;
  day: string;
  micros: number;
};

export const AI_SPEND_SCOPE = 'ai.daily';

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object'
    ? (row as Record<string, unknown>)
    : null;
}

/**
 * The UTC day send_protection_spend_add charged (it returns it), so the
 * refund hits the same day even across midnight. Only an unreadable reply
 * falls back to our clock.
 */
export function spendDay(raw: unknown, now: () => Date): string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : now().toISOString().slice(0, 10);
}

const denyDegraded: AiSpendDecision = {
  allowed: false,
  degraded: true,
  reservation: null,
};

export async function reserveAiSpend(
  client: SpendRpcClient,
  accountId: string,
  micros: number,
  now: () => Date = () => new Date()
): Promise<AiSpendDecision> {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new TypeError('micros must be a non-negative integer');
  }
  let cap: number | null;
  try {
    const { data, error } = await client.rpc('send_protection_caps_get', {
      p_account: accountId,
    });
    if (error) return denyDegraded;
    const raw = firstRow(data)?.daily_ai_spend_micros;
    cap = raw === null || raw === undefined ? null : Number(raw);
  } catch {
    return denyDegraded;
  }
  if (cap === null) return { allowed: true, reservation: null };

  try {
    const { data, error } = await client.rpc('send_protection_spend_add', {
      p_account: accountId,
      p_scope: AI_SPEND_SCOPE,
      p_micros: micros,
      p_hard_cap: cap,
    });
    const row = firstRow(data);
    if (error || !row || typeof row.allowed !== 'boolean') return denyDegraded;
    const totalMicros = Number(row.total_micros);
    const day = spendDay(row.day, now);
    return row.allowed
      ? { allowed: true, totalMicros, reservation: { accountId, day, micros } }
      : { allowed: false, totalMicros, reservation: null };
  } catch {
    return denyDegraded;
  }
}

/**
 * Adds money already spent, with no cap: a call that ran is always
 * counted, so the next reservation sees the true total. Never throws.
 */
export async function recordAiSpend(
  client: SpendRpcClient,
  accountId: string,
  micros: number
): Promise<boolean> {
  if (!Number.isSafeInteger(micros) || micros <= 0) return true;
  try {
    const { error } = await client.rpc('send_protection_spend_add', {
      p_account: accountId,
      p_scope: AI_SPEND_SCOPE,
      p_micros: micros,
      p_hard_cap: null,
    });
    return !error;
  } catch {
    return false;
  }
}

/** Gives a reservation back (the AI call did not happen). Never throws. */
export async function refundAiSpend(
  client: SpendRpcClient,
  reservation: AiSpendReservation | null
): Promise<boolean> {
  if (!reservation || reservation.micros === 0) return true;
  try {
    const { error } = await client.rpc('send_protection_spend_refund', {
      p_account: reservation.accountId,
      p_scope: AI_SPEND_SCOPE,
      p_day: reservation.day,
      p_micros: reservation.micros,
    });
    return !error;
  } catch {
    return false;
  }
}
