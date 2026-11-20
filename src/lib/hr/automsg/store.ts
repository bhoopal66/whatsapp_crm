/**
 * HR automated messages: the database adapter over migration 203's
 * service-role functions. Every read and write is an RPC (the tables are
 * RLS-forced with no grants); jsonb snake_case is mapped to the camelCase
 * shapes in `ports.ts` / `types.ts`. A refusal raised by `hr_refuse`
 * carries its code in the Postgres HINT, which is rethrown as `hint` on
 * the Error so the engine can tell ALREADY_DECIDED (a parallel drain won)
 * from a real failure.
 *
 * Server-only: takes a service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AutoMsgStorePort,
  ClaimOutcome,
  OutboxRow,
  RowState,
  StoredTemplate,
} from './ports';
import {
  DEFAULT_SETTINGS,
  type AutoMsgSettings,
  type HoldReason,
  type Trigger,
} from './types';

type Json = Record<string, unknown>;

/** An Error carrying the Postgres HINT (`hr_refuse`'s code) and SQLSTATE. */
export class AutoMsgRpcError extends Error {
  constructor(
    message: string,
    readonly hint: string | null,
    readonly code: string | null
  ) {
    super(message);
    this.name = 'AutoMsgRpcError';
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Json)
    : null;
}

/** One `hr_automsg_outbox` row (from `to_jsonb(o)` or a SETOF row). */
export function toOutboxRow(r: Json): OutboxRow {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(r.params) ?? {}))
    if (typeof v === 'string') params[k] = v;
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    conversationId: String(r.conversation_id),
    contactId: String(r.contact_id),
    trigger: r.trigger as OutboxRow['trigger'],
    templateKind: r.template_kind as OutboxRow['templateKind'],
    language: r.language as OutboxRow['language'],
    params,
    bodyRendered: str(r.body_rendered),
    dedupeKey: String(r.dedupe_key),
    status: r.status as OutboxRow['status'],
    holdReason: (str(r.hold_reason) as HoldReason | null) ?? null,
    attempts: num(r.attempts, 0),
    claimState: (str(r.claim_state) as OutboxRow['claimState']) ?? null,
    createdAt: String(r.created_at),
    sentAt: str(r.sent_at),
  };
}

function toTemplate(t: Json | null): StoredTemplate | null {
  if (!t) return null;
  return {
    kind: t.kind as StoredTemplate['kind'],
    language: t.language as StoredTemplate['language'],
    body: str(t.body) ?? '',
    metaTemplateName: str(t.meta_template_name) ?? '',
    approvalStatus: t.approval_status as StoredTemplate['approvalStatus'],
    category: t.category as StoredTemplate['category'],
  };
}

/**
 * `hr_automsg_settings_json()` has no trigger list: the row's own trigger
 * switch comes separately as `trigger_enabled`, and is the only one a
 * row's decision reads.
 */
function toSettings(
  s: Json | null,
  row: OutboxRow,
  triggerEnabled: boolean
): AutoMsgSettings {
  const d = DEFAULT_SETTINGS;
  return {
    killSwitch: bool(s?.kill_switch, d.killSwitch),
    quietStart: str(s?.quiet_start) ?? d.quietStart,
    quietEnd: str(s?.quiet_end) ?? d.quietEnd,
    tz: str(s?.tz) ?? d.tz,
    requiresConsent: bool(s?.requires_consent, d.requiresConsent),
    dailyCap: num(s?.daily_cap, d.dailyCap),
    triggers: {
      [row.trigger as Trigger]: {
        enabled: triggerEnabled,
        templateKind: row.templateKind,
      },
    },
  };
}

/** camelCase of `hr_automsg_row_state()`. */
export function toRowState(j: Json): RowState {
  const row = toOutboxRow(obj(j.row) ?? {});
  const triggerEnabled = bool(j.trigger_enabled, false);
  const inbox = str(j.inbox);
  return {
    row,
    closed: bool(j.closed, true),
    inbox: inbox === 'recruiter' || inbox === 'dept' ? inbox : null,
    personal: bool(j.personal, false),
    optedOut: bool(j.opted_out, false),
    consent: bool(j.consent, false),
    lastInboundAt: str(j.last_inbound_at),
    contactName: str(j.contact_name),
    settings: toSettings(obj(j.settings), row, triggerEnabled),
    triggerEnabled,
    template: toTemplate(obj(j.template)),
    sentToday: num(j.sent_today, 0),
  };
}

export class PgAutoMsgStore implements AutoMsgStorePort {
  constructor(private readonly db: SupabaseClient) {}

  private async call<T>(fn: string, args: Json): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      const e = error as { message?: string; hint?: string; code?: string };
      throw new AutoMsgRpcError(
        e.message ?? `${fn} failed`,
        e.hint || null,
        e.code || null
      );
    }
    return data as T;
  }

  async state(id: string): Promise<RowState | null> {
    const j = await this.call<Json | null>('hr_automsg_row_state', {
      p_id: id,
    });
    return obj(j) ? toRowState(j as Json) : null;
  }

  async hold(id: string, reason: HoldReason): Promise<void> {
    await this.call('hr_automsg_mark', {
      p_id: id,
      p_status: 'held',
      p_hold_reason: reason,
    });
  }

  async cancel(id: string): Promise<void> {
    await this.call('hr_automsg_mark', { p_id: id, p_status: 'cancelled' });
  }

  async claim(id: string, now: Date): Promise<ClaimOutcome> {
    const r = await this.call<string>('hr_automsg_claim', {
      p_id: id,
      p_now: now.toISOString(),
    });
    return r === 'claimed' || r === 'capped' ? r : 'lost';
  }

  async markSent(
    id: string,
    r: {
      providerMessageId: string | null;
      messageId: string | null;
      bodyRendered: string;
    }
  ): Promise<void> {
    await this.call('hr_automsg_mark', {
      p_id: id,
      p_status: 'sent',
      p_provider_message_id: r.providerMessageId,
      p_message_id: r.messageId,
      p_body_rendered: r.bodyRendered,
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.call('hr_automsg_mark', {
      p_id: id,
      p_status: 'failed',
      p_error: error,
    });
  }

  /** Migration 212: failed, attempts spent, never retried. */
  async failTerminal(id: string, reason: string): Promise<void> {
    await this.call('hr_automsg_fail_terminal', {
      p_id: id,
      p_reason: reason,
    });
  }

  async settleUnconfirmed(
    id: string,
    providerMessageId: string | null
  ): Promise<void> {
    await this.call('hr_automsg_settle_unconfirmed', {
      p_id: id,
      p_provider_message_id: providerMessageId,
    });
  }

  /** Undecided rows, oldest first (SQL caps the limit at 1..500). */
  async due(limit: number, accountId?: string): Promise<OutboxRow[]> {
    const rows = await this.call<Json[] | null>('hr_automsg_due', {
      p_limit: limit,
      p_account_id: accountId ?? null,
    });
    return (rows ?? []).map(toOutboxRow);
  }

  /** Claims stuck 'sending' over 15 minutes -> needs_review. */
  async reviewStuck(now: Date): Promise<number> {
    return num(
      await this.call('hr_automsg_review_stuck', { p_now: now.toISOString() }),
      0
    );
  }

  /** Undecided rows older than 24 hours -> cancelled. */
  async expire(now: Date): Promise<number> {
    return num(
      await this.call('hr_automsg_expire', { p_now: now.toISOString() }),
      0
    );
  }

  /** Queues reply-overdue nudges; returns how many rows were added. */
  async enqueueNudges(now: Date): Promise<number> {
    return num(
      await this.call('hr_automsg_enqueue_nudges', {
        p_now: now.toISOString(),
      }),
      0
    );
  }
}
