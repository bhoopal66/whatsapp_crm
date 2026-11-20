/**
 * In-memory AutoMsgStorePort with migration 203's semantics, for tests:
 * claim only from queued/held/failed with no claim and attempts below
 * MAX_ATTEMPTS (attempts + 1, the daily cap recounted at claim time);
 * hold/cancel only an undecided row; the marks only a row claimed
 * 'sending'. A refused transition throws ALREADY_DECIDED (as `hint`).
 */
import { localDay } from './guards';
import type {
  AutoMsgStorePort,
  ClaimOutcome,
  ClockPort,
  RowState,
} from './ports';
import { MAX_ATTEMPTS, type HoldReason, type OutboxRow } from './types';

export type MemoryContext = Omit<RowState, 'row' | 'sentToday'>;

export class MemoryAutoMsgStore implements AutoMsgStorePort {
  rows = new Map<string, OutboxRow>();
  errors = new Map<string, string>();
  providerIds = new Map<string, string | null>();

  constructor(
    public ctx: MemoryContext,
    private readonly clock: ClockPort
  ) {}

  add(row: OutboxRow): void {
    this.rows.set(row.id, { ...row });
  }

  private get(id: string): OutboxRow {
    const r = this.rows.get(id);
    if (!r) throw Object.assign(new Error('NOT_FOUND'), { hint: 'NOT_FOUND' });
    return r;
  }

  private refuse(): never {
    throw Object.assign(new Error('ALREADY_DECIDED'), {
      hint: 'ALREADY_DECIDED',
    });
  }

  private undecided(r: OutboxRow): boolean {
    return (
      ['queued', 'held', 'failed'].includes(r.status) && r.claimState === null
    );
  }

  /** Sent today (local day) to the row's contact, in-flight claims included. */
  sentToday(r: OutboxRow, now: Date): number {
    const tz = this.ctx.settings.tz;
    const day = localDay(now, tz);
    let n = 0;
    for (const x of this.rows.values()) {
      if (x.accountId !== r.accountId || x.contactId !== r.contactId) continue;
      const counted = x.status === 'sent' || x.claimState === 'sending';
      if (counted && x.sentAt && localDay(new Date(x.sentAt), tz) === day) n++;
    }
    return n;
  }

  async state(id: string): Promise<RowState | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return {
      ...this.ctx,
      row: { ...r },
      sentToday: this.sentToday(r, this.clock.now()),
    };
  }

  async hold(id: string, reason: HoldReason): Promise<void> {
    const r = this.get(id);
    if (!this.undecided(r)) this.refuse();
    r.status = 'held';
    r.holdReason = reason;
  }

  async cancel(id: string): Promise<void> {
    const r = this.get(id);
    if (!this.undecided(r)) this.refuse();
    r.status = 'cancelled';
  }

  async claim(id: string, now: Date): Promise<ClaimOutcome> {
    const r = this.get(id);
    if (!this.undecided(r) || r.attempts >= MAX_ATTEMPTS) return 'lost';
    if (this.sentToday(r, now) >= this.ctx.settings.dailyCap) {
      r.status = 'held';
      r.holdReason = 'daily_cap';
      return 'capped';
    }
    r.status = 'queued';
    r.holdReason = null;
    r.attempts += 1;
    r.claimState = 'sending';
    r.sentAt = now.toISOString();
    return 'claimed';
  }

  async markSent(
    id: string,
    m: {
      providerMessageId: string | null;
      messageId: string | null;
      bodyRendered: string;
    }
  ): Promise<void> {
    const r = this.get(id);
    if (r.claimState !== 'sending') this.refuse();
    r.status = 'sent';
    r.claimState = null;
    r.bodyRendered = m.bodyRendered;
    r.sentAt = this.clock.now().toISOString();
    this.providerIds.set(id, m.providerMessageId);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const r = this.get(id);
    if (r.claimState !== 'sending') this.refuse();
    r.status = 'failed';
    r.claimState = null;
    r.holdReason = null;
    r.sentAt = null;
    this.errors.set(id, error);
  }

  async failTerminal(id: string, reason: string): Promise<void> {
    const r = this.get(id);
    if (r.claimState !== 'sending') this.refuse();
    r.status = 'failed';
    r.attempts = MAX_ATTEMPTS;
    r.claimState = null;
    r.holdReason = null;
    r.sentAt = null;
    this.errors.set(id, reason);
  }

  async settleUnconfirmed(
    id: string,
    providerMessageId: string | null
  ): Promise<void> {
    const r = this.get(id);
    if (r.claimState !== 'sending') this.refuse();
    r.status = 'sent';
    r.claimState = 'unconfirmed';
    this.providerIds.set(id, providerMessageId);
  }
}
