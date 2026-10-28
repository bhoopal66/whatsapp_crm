import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';

// ------------------------------------------------------------
// The home "WhatsApp numbers" card: is every number up? `status` is
// kept current by the health monitor (`channel-health.ts`), which only
// ever writes 'connected' or 'disconnected'; anything else (an older
// row, a value a later migration adds) is shown as unknown rather than
// guessed at.
// ------------------------------------------------------------

export type NumberState = 'connected' | 'disconnected' | 'unknown';

export function numberState(status: string | null | undefined): NumberState {
  if (status === 'connected' || status === 'disconnected') return status;
  return 'unknown';
}

export type NumberFields = Pick<
  AccountNumber,
  'id' | 'provider' | 'label' | 'waba_id' | 'is_primary' | 'status'
>;

export interface NumberHealthRow<T extends NumberFields = NumberFields> {
  number: T;
  state: NumberState;
}

export interface NumberHealth<T extends NumberFields = NumberFields> {
  total: number;
  connected: number;
  disconnected: number;
  unknown: number;
  /**
   * The summary line: every number connected, some disconnected, or
   * neither (nothing down, but at least one not known to be up).
   */
  summary: 'all_connected' | 'some_disconnected' | 'partly_known' | 'none';
  /** Disconnected first, then the primary, then the account's order. */
  rows: NumberHealthRow<T>[];
}

const STATE_RANK: Record<NumberState, number> = {
  disconnected: 0,
  unknown: 1,
  connected: 2,
};

export function numberHealth<T extends NumberFields>(
  numbers: readonly T[]
): NumberHealth<T> {
  const rows = numbers
    .map((number, i) => ({ number, state: numberState(number.status), i }))
    .sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        Number(b.number.is_primary) - Number(a.number.is_primary) ||
        a.i - b.i
    )
    .map(({ number, state }) => ({ number, state }));
  const count = (s: NumberState) => rows.filter((r) => r.state === s).length;
  const connected = count('connected');
  const disconnected = count('disconnected');
  const unknown = count('unknown');
  const total = rows.length;
  return {
    total,
    connected,
    disconnected,
    unknown,
    summary:
      total === 0
        ? 'none'
        : disconnected > 0
          ? 'some_disconnected'
          : unknown > 0
            ? 'partly_known'
            : 'all_connected',
    rows,
  };
}

/**
 * What to call a number: its label, else the connected phone for a
 * linked device (Whapi, OpenWA keep it in `waba_id`). Null for an
 * unlabelled Cloud API number, whose `waba_id` is the WABA id and no
 * name for a number: the card says "Cloud API number" instead.
 */
export function numberName(
  n: Pick<AccountNumber, 'provider' | 'label' | 'waba_id'>
): string | null {
  const label = n.label?.trim();
  if (label) return label;
  if (n.provider !== 'meta' && n.waba_id) {
    return `+${n.waba_id.replace(/^\+/, '')}`;
  }
  return null;
}
