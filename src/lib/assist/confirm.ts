/**
 * Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (src/assist/confirm.ts), moved from
 * node-postgres to supabase-js RPC on the service-role client (migration 120). "workspace" (workspaceId) means the
 * wacrm account id; ids are uuids. Database errors throw ConfirmStateUnavailableError (the guard denies
 * CONFIRM_STATE_UNAVAILABLE); expiry is classified on the injected clock against the row's expires_at.
 *
 * ConfirmationGate: server-side human confirmation of an assistant action, stored in public.assist_pending_actions.
 *
 *   request(action, scope)      model path. assist_pending_request stores a pending row (action_hash = sha256 canonical
 *                               {tool,args}); the DATABASE generates the nonce (kept only as sha256) and fixes
 *                               expires_at = now() + 300 s, so no caller chooses either. Returns the pendingId plus the
 *                               prompt for the HUMAN (it carries the nonce; the router never hands it to the model).
 *   confirm / deny (ConfirmApi) human path only. Requires a HumanOrigin minted by humanOriginFromChannel (the
 *                               application calls it from its authenticated channel); a structurally identical object
 *                               built elsewhere (e.g. from model output) is refused ORIGIN_NOT_HUMAN. pending -> confirmed
 *                               (or denied) in ONE atomic UPDATE ... WHERE status = 'pending' AND same user AND same
 *                               workspace AND nonce matches AND not expired RETURNING; anything else is refused and audited.
 *   consume(pendingId, action, scope, decision)
 *                               execution path. confirmed -> consumed in one atomic UPDATE that also requires the
 *                               presented {tool,args} to hash to the stored action_hash: a changed argument is refused
 *                               HASH_MISMATCH, and two concurrent consumers get exactly one success. wacrm change: the
 *                               reference committed the consume and its decision audit row in one client transaction
 *                               (tx.ts, not ported); here assist_pending_consume writes the 'ALLOW:CONFIRMED' decision row
 *                               (run id, tool, detail from `decision`) in the same call, and raises with HINT
 *                               AUDIT_UNAVAILABLE (nothing consumed, the row stays confirmed) when that insert fails:
 *                               thrown as AuditUnavailableError.
 *                               At most 5 open pending rows per user, fixed in the DB (assist_pending_request):
 *                               beyond it request throws PendingCapError.
 *   sweep()                     pending|confirmed past expires_at -> expired.
 *   cancelPending(id, reason)   system path. pending -> denied (actor 'system:assist') plus a decision audit row
 *                               'DENY:<reason>', in one call (assist_pending_cancel); for a row the human can never act
 *                               on (notify or decision audit failed), so it stops holding a cap slot. No-op (false)
 *                               for any row no longer pending.
 * Every status change runs in a SECURITY DEFINER function (assist_pending_confirm / _consume / _expire / _cancel, migration 120)
 * that re-checks nonce (confirm hashes the raw nonce itself), user, workspace, status and expires_at; service_role has
 * no UPDATE on the table. Postgres triggers enforce the forward-only transitions and copy each one into assist_audit.
 * The model-facing router is typed without any of the ConfirmApi methods.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { actionHash } from './canonical';
import { systemClock, type Clock } from './loop';
import type { ResolvedToolSpec, RiskLevel } from './registry';
import { ToolRegistry } from './registry';

/** Pending-action lifetime. Fixed in assist_pending_request (interval '300 seconds'); used here only for the prompt. */
export const PENDING_TTL_MS = 5 * 60_000;
/** Open (pending, unexpired) actions one user may have at once, fixed in assist_pending_request (confirmation fatigue). */
export const MAX_OPEN_PER_USER = 5;

/** request() refused: the user already has MAX_OPEN_PER_USER open pending actions. No row, no prompt. */
export class PendingCapError extends Error {
  constructor() {
    super('assist: open pending action cap reached');
    this.name = 'PendingCapError';
  }
}

/** A gate database call failed (or answered nothing usable). The guard denies CONFIRM_STATE_UNAVAILABLE. */
export class ConfirmStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmStateUnavailableError';
  }
}

/** assist_pending_consume could not append its decision audit row: nothing was consumed. The guard denies AUDIT_UNAVAILABLE. */
export class AuditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

export interface AssistAction {
  readonly tool: string;
  readonly args: unknown;
}

export interface ActionScope {
  readonly userId: string;
  /** The wacrm account id. */
  readonly workspaceId: string;
  readonly runId?: string;
}

/** The decision audit row assist_pending_consume writes when it consumes ({mode, risk} in detail). */
export interface ConsumeDecision {
  readonly runId: string | null;
  readonly tool: string;
  readonly detail: Record<string, unknown>;
}

export const CONFIRM_REFUSALS = {
  ORIGIN_NOT_HUMAN: 'ORIGIN_NOT_HUMAN',
  NOT_FOUND: 'NOT_FOUND',
  WRONG_USER: 'WRONG_USER',
  BAD_NONCE: 'BAD_NONCE',
  EXPIRED: 'EXPIRED',
  NOT_PENDING: 'NOT_PENDING',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  HASH_MISMATCH: 'HASH_MISMATCH',
} as const;
export type ConfirmRefusal =
  (typeof CONFIRM_REFUSALS)[keyof typeof CONFIRM_REFUSALS];

export type GateOutcome =
  { ok: true; pendingId: string } | { ok: false; reason: ConfirmRefusal };

// ---- human origin --------------------------------------------------------------------------------------------
declare const HUMAN: unique symbol;
/** Proof that a call comes from an authenticated human channel. Only humanOriginFromChannel creates one. */
export interface HumanOrigin {
  readonly origin: 'human';
  readonly userId: string;
  /** The wacrm account id. */
  readonly workspaceId: string;
  readonly channel: string;
  readonly [HUMAN]: true;
}
const minted = new WeakSet<object>();

/**
 * Called by the application layer from its authenticated channel handler (the user replied in WhatsApp / the web app),
 * never from the assistant's tool-call path.
 */
export function humanOriginFromChannel(session: {
  userId: string;
  workspaceId: string;
  channel: string;
}): HumanOrigin {
  if (!session.userId || !session.workspaceId)
    throw new TypeError(
      'humanOriginFromChannel: an authenticated user and workspace are required'
    );
  const o = Object.freeze({
    origin: 'human' as const,
    userId: session.userId,
    workspaceId: session.workspaceId,
    channel: session.channel,
  });
  minted.add(o);
  return o as unknown as HumanOrigin;
}
const isMintedHuman = (o: unknown): o is HumanOrigin =>
  typeof o === 'object' &&
  o !== null &&
  minted.has(o) &&
  (o as { origin?: unknown }).origin === 'human';

/** The human-only surface. Never handed to the model tool router. */
export interface ConfirmApi {
  confirm(
    origin: HumanOrigin,
    pendingId: string,
    nonce: string
  ): Promise<GateOutcome>;
  deny(
    origin: HumanOrigin,
    pendingId: string,
    nonce: string
  ): Promise<GateOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres answers uuids in lower case; a caller may not. */
const sameId = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

type Row = {
  id: string;
  user_id: string;
  account_id: string;
  status: string;
  action_hash: string;
  expired: boolean;
};

type RpcError = { message: string; code?: string; hint?: string | null };

export class ConfirmationGate implements ConfirmApi {
  private readonly clock: Clock;

  constructor(
    private readonly db: SupabaseClient,
    private readonly opts: { registry?: ToolRegistry; clock?: Clock } = {}
  ) {
    this.clock = opts.clock ?? systemClock;
  }

  /** spec: the registry entry the prompt is built from (AssistGuard passes its own registry's). */
  async request(
    action: AssistAction,
    scope: ActionScope,
    spec: ResolvedToolSpec = (this.opts.registry ?? new ToolRegistry()).spec(
      action.tool
    )
  ): Promise<{ pendingId: string; humanPrompt: string; nonce: string }> {
    const hash = actionHash(action.tool, action.args);
    const data = await this.rpc('assist_pending_request', {
      p_account: scope.workspaceId,
      p_user: scope.userId,
      p_run: scope.runId ?? null,
      p_tool: action.tool,
      p_args: action.args ?? null,
      p_action_hash: hash,
      p_actor: `assistant:${scope.userId}`,
    });
    const row = (Array.isArray(data) ? data[0] : undefined) as
      { id: string; nonce: string } | undefined;
    if (!row) throw new PendingCapError();
    const { id: pendingId, nonce } = row;
    const humanPrompt = buildHumanPrompt({
      tool: action.tool,
      args: action.args,
      spec,
      workspaceId: scope.workspaceId,
      nonce,
      ttlMs: PENDING_TTL_MS,
    });
    return { pendingId, humanPrompt, nonce };
  }

  confirm(
    origin: HumanOrigin,
    pendingId: string,
    nonce: string
  ): Promise<GateOutcome> {
    return this.decide(origin, pendingId, nonce, 'confirmed');
  }

  deny(
    origin: HumanOrigin,
    pendingId: string,
    nonce: string
  ): Promise<GateOutcome> {
    return this.decide(origin, pendingId, nonce, 'denied');
  }

  private async decide(
    origin: HumanOrigin,
    pendingId: string,
    nonce: string,
    to: 'confirmed' | 'denied'
  ): Promise<GateOutcome> {
    if (!isMintedHuman(origin))
      return this.refuse(
        'confirm_refused',
        CONFIRM_REFUSALS.ORIGIN_NOT_HUMAN,
        pendingId,
        'unknown'
      );
    const actor = `human:${origin.userId}@${origin.channel}`;
    if (!UUID.test(pendingId))
      return this.refuse(
        'confirm_refused',
        CONFIRM_REFUSALS.NOT_FOUND,
        null,
        actor,
        origin
      );
    const moved = await this.rpc('assist_pending_confirm', {
      p_id: pendingId,
      p_user: origin.userId,
      p_account: origin.workspaceId,
      p_nonce: String(nonce),
      p_actor: actor,
      p_decision: to,
    });
    if (moved === true) return { ok: true, pendingId };
    const row = await this.load(pendingId);
    let reason: ConfirmRefusal;
    if (!row) reason = CONFIRM_REFUSALS.NOT_FOUND;
    else if (
      !sameId(row.user_id, origin.userId) ||
      !sameId(row.account_id, origin.workspaceId)
    )
      reason = CONFIRM_REFUSALS.WRONG_USER;
    else if (row.status !== 'pending')
      reason =
        row.status === 'expired'
          ? CONFIRM_REFUSALS.EXPIRED
          : CONFIRM_REFUSALS.NOT_PENDING;
    else if (row.expired) {
      await this.expireOne(pendingId, actor);
      reason = CONFIRM_REFUSALS.EXPIRED;
    } else reason = CONFIRM_REFUSALS.BAD_NONCE;
    return this.refuse(
      'confirm_refused',
      reason,
      row ? pendingId : null,
      actor,
      origin,
      row?.action_hash
    );
  }

  /**
   * confirmed -> consumed, once, only for the same user/workspace and the exact {tool,args} that was confirmed; the
   * decision audit row is written by the same database call. Throws AuditUnavailableError when that row could not be
   * written (nothing consumed), ConfirmStateUnavailableError on any other database error.
   */
  async consume(
    pendingId: string,
    action: AssistAction,
    scope: ActionScope,
    decision: ConsumeDecision
  ): Promise<GateOutcome> {
    const actor = `assistant:${scope.userId}`;
    if (!UUID.test(pendingId))
      return this.refuse(
        'consume_refused',
        CONFIRM_REFUSALS.NOT_FOUND,
        null,
        actor,
        scope
      );
    const hash = actionHash(action.tool, action.args);
    const moved = await this.rpc(
      'assist_pending_consume',
      {
        p_id: pendingId,
        p_user: scope.userId,
        p_account: scope.workspaceId,
        p_action_hash: hash,
        p_actor: actor,
        p_run_id: decision.runId,
        p_tool: decision.tool,
        p_detail: decision.detail,
      },
      (e) =>
        e.hint === 'AUDIT_UNAVAILABLE'
          ? new AuditUnavailableError(`assist_pending_consume: ${e.message}`)
          : null
    );
    if (moved === true) return { ok: true, pendingId };
    const row = await this.load(pendingId);
    let reason: ConfirmRefusal;
    if (!row) reason = CONFIRM_REFUSALS.NOT_FOUND;
    else if (
      !sameId(row.user_id, scope.userId) ||
      !sameId(row.account_id, scope.workspaceId)
    )
      reason = CONFIRM_REFUSALS.WRONG_USER;
    else if (row.status === 'pending') reason = CONFIRM_REFUSALS.NOT_CONFIRMED;
    else if (row.status !== 'confirmed')
      reason =
        row.status === 'expired'
          ? CONFIRM_REFUSALS.EXPIRED
          : CONFIRM_REFUSALS.NOT_PENDING;
    else if (row.action_hash !== hash) reason = CONFIRM_REFUSALS.HASH_MISMATCH;
    else if (row.expired) {
      await this.expireOne(pendingId, actor);
      reason = CONFIRM_REFUSALS.EXPIRED;
    } else reason = CONFIRM_REFUSALS.NOT_PENDING; // lost a race to a concurrent consumer
    return this.refuse(
      'consume_refused',
      reason,
      row ? pendingId : null,
      actor,
      scope,
      hash
    );
  }

  /** Expires every pending / confirmed action past its expiry. Returns how many. */
  async sweep(actor = 'system:sweep'): Promise<number> {
    return Number(
      (await this.rpc('assist_pending_expire', { p_actor: actor })) ?? 0
    );
  }

  /** pending -> denied with a 'DENY:<reason>' decision audit row (one DB call). false: the row was not pending. Throws on a DB error. */
  async cancelPending(pendingId: string, reason: string): Promise<boolean> {
    if (!UUID.test(pendingId)) return false;
    return (
      (await this.rpc('assist_pending_cancel', {
        p_id: pendingId,
        p_reason: reason,
      })) === true
    );
  }

  private async rpc(
    fn: string,
    args: Record<string, unknown>,
    map: (e: RpcError) => Error | null = () => null
  ): Promise<unknown> {
    let res: { data: unknown; error: RpcError | null };
    try {
      res = await this.db.rpc(fn, args);
    } catch (e) {
      throw new ConfirmStateUnavailableError(
        `${fn}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (res.error)
      throw (
        map(res.error) ??
        new ConfirmStateUnavailableError(`${fn}: ${res.error.message}`)
      );
    return res.data;
  }

  private async load(pendingId: string): Promise<Row | undefined> {
    const { data, error } = await this.db
      .from('assist_pending_actions')
      .select('id, user_id, account_id, status, action_hash, expires_at')
      .eq('id', pendingId)
      .maybeSingle();
    if (error)
      throw new ConfirmStateUnavailableError(
        `assist_pending_actions: ${error.message}`
      );
    if (!data) return undefined;
    const r = data as Omit<Row, 'expired'> & { expires_at: string };
    return {
      id: r.id,
      user_id: r.user_id,
      account_id: r.account_id,
      status: r.status,
      action_hash: r.action_hash,
      expired: Date.parse(r.expires_at) <= this.clock.now(),
    };
  }

  private async expireOne(pendingId: string, actor: string): Promise<void> {
    await this.rpc('assist_pending_expire', {
      p_actor: actor,
      p_id: pendingId,
    });
  }

  private async refuse(
    kind: 'confirm_refused' | 'consume_refused',
    reason: ConfirmRefusal,
    pendingId: string | null,
    actor: string,
    who?: { userId: string; workspaceId: string },
    hash?: string
  ): Promise<GateOutcome> {
    const { error } = await this.db.from('assist_audit').insert({
      kind,
      actor,
      account_id: who?.workspaceId ?? null,
      user_id: who?.userId ?? null,
      pending_id: pendingId && UUID.test(pendingId) ? pendingId : null,
      action_hash: hash ?? null,
      outcome: reason,
    });
    if (error)
      throw new ConfirmStateUnavailableError(`assist_audit: ${error.message}`);
    return { ok: false, reason };
  }
}

// ---- human prompt -------------------------------------------------------------------------------------------
export const PROMPT_MAX_CHARS = 1000;
export const PROMPT_VALUE_MAX_CHARS = 80;
const LABEL_MAX = 40;
const HEADER_MAX = 64;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Model-supplied text for the human prompt: control / format / line-separator characters become spaces. */
export const cleanText = (s: string): string =>
  s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}\u2026`;

function renderValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(cleanText(v));
  try {
    return cleanText(JSON.stringify(v) ?? String(v));
  } catch {
    return cleanText(String(v));
  }
}

function defaultFields(args: unknown): Array<readonly [string, string]> {
  if (args === null || args === undefined) return [];
  if (typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .map((k) => [k, renderValue(o[k])] as const);
  }
  return [['value', renderValue(args)]];
}

/**
 * The confirmation prompt shown to the HUMAN, built from the registry entry: display name, risk level, workspace,
 * then the args block (describeArgs or the sorted key list), each value at most 80 chars, the whole prompt at most
 * 1000 chars with an explicit '… (truncated, N more fields)' marker. Model-supplied text appears only inside the args
 * block (an unregistered tool's name included) and never carries a newline or control character.
 */
export function buildHumanPrompt(p: {
  tool: string;
  args: unknown;
  spec: ResolvedToolSpec & { risk: RiskLevel };
  workspaceId: string;
  nonce: string;
  ttlMs: number;
}): string {
  let fields: ReadonlyArray<readonly [string, string]>;
  try {
    fields = p.spec.describeArgs
      ? p.spec.describeArgs(p.args)
      : defaultFields(p.args);
    if (!Array.isArray(fields)) fields = defaultFields(p.args);
  } catch {
    fields = defaultFields(p.args);
  }
  if (!p.spec.registered) fields = [['tool', renderValue(p.tool)], ...fields];
  const head = [
    'Assistant action awaiting your confirmation',
    `Tool: ${clip(cleanText(p.spec.displayName), HEADER_MAX)}`,
    `Risk: ${p.spec.risk}`,
    `Workspace: ${clip(cleanText(p.workspaceId), HEADER_MAX)}`,
    fields.length === 0 ? 'Arguments: (none)' : 'Arguments:',
  ].join('\n');
  const foot = `Reply CONFIRM ${p.nonce} to allow it once, or DENY ${p.nonce}. This request expires in ${Math.round(p.ttlMs / 1000)}s.`;
  const marker = (k: number) => `  \u2026 (truncated, ${k} more fields)`;
  const budget = PROMPT_MAX_CHARS - head.length - foot.length - 2;
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < fields.length; i++) {
    const [label, value] = fields[i]!;
    const line = `  ${clip(cleanText(String(label)), LABEL_MAX)}: ${clip(cleanText(String(value)), PROMPT_VALUE_MAX_CHARS)}`;
    const reserve =
      i < fields.length - 1 ? marker(fields.length - i - 1).length + 1 : 0;
    if (used + line.length + 1 + reserve > budget) {
      lines.push(marker(fields.length - i));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [head, ...lines, foot].join('\n');
}
