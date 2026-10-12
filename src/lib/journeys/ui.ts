/**
 * Pure helpers behind the journey screens (module 016): the contact
 * panel's Journey card and consent block, and the Journeys page. No
 * I/O, so the rules are unit-tested without a DOM. Everything that
 * depends on the workflow reads the definition, so a workflow change
 * moves the screens with it.
 */
import type { AdvisorDecision, HistoryEntry, Timer } from './types';
import { NEW_STATE } from './types';
import type { Product, StateDef, TransitionDef, WorkflowDef } from './schema';
import { advisorDecisionsFor } from './host/advisor';
import { windowState } from './policy';
import { toMs } from './time';

/** The funnel's columns, in order; Parked and Closed sit apart. */
export const JOURNEY_STAGES = [
  'menu',
  'pitch',
  'quote',
  'docs',
  'submitted',
  'fulfilment',
  'won',
  'parked',
  'closed',
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

const STAGE_OF: Record<string, JourneyStage> = {
  [NEW_STATE]: 'menu',
  S_MENU: 'menu',
  P_PITCH: 'pitch',
  B_PITCH: 'pitch',
  L_PITCH: 'pitch',
  P_QUOTE_WAIT: 'quote',
  P_COMPARE_WAIT: 'quote',
  P_DECIDE: 'quote',
  PRESCREEN: 'quote',
  DOCS: 'docs',
  SUBMITTED: 'submitted',
  REMATCH: 'submitted',
  FULFILMENT: 'fulfilment',
  WON: 'won',
  PARKED: 'parked',
  RE_ENGAGE: 'parked',
};

/** The funnel stage of a workflow state; any CLOSED_* state is Closed, an unknown one null. */
export function stageOf(state: string): JourneyStage | null {
  return STAGE_OF[state] ?? (state.startsWith('CLOSED_') ? 'closed' : null);
}

/** Journeys per funnel stage (every stage present, zeros included). */
export function countByStage(
  journeys: readonly { state: string }[]
): Record<JourneyStage, number> {
  const counts = Object.fromEntries(
    JOURNEY_STAGES.map((s) => [s, 0])
  ) as Record<JourneyStage, number>;
  for (const j of journeys) {
    const s = stageOf(j.state);
    if (s) counts[s] += 1;
  }
  return counts;
}

/** Workflow states with a human label in `Journeys.states`. */
export const LABELLED_STATES = [
  NEW_STATE,
  'S_MENU',
  'P_PITCH',
  'P_QUOTE_WAIT',
  'P_COMPARE_WAIT',
  'P_DECIDE',
  'B_PITCH',
  'L_PITCH',
  'PRESCREEN',
  'DOCS',
  'SUBMITTED',
  'REMATCH',
  'FULFILMENT',
  'WON',
  'PARKED',
  'RE_ENGAGE',
  'CLOSED_NO_FIT',
  'CLOSED_DECLINED',
  'CLOSED_REJECTED',
  'CLOSED_NO_RESPONSE',
  'CLOSED_OPTED_OUT',
  'CLOSED_ADVISOR',
] as const;

/** `Journeys.states` key for a state, or null (show the raw state). */
export function stateLabelKey(state: string): string | null {
  return (LABELLED_STATES as readonly string[]).includes(state) ? state : null;
}

export type WindowStatus =
  | { kind: 'freeEntry'; until: string }
  | { kind: 'open'; until: string }
  | { kind: 'closed' };

/**
 * The customer's messaging window now: the ad's free-entry window when
 * it is open (it outlasts the service window), else the 24-hour service
 * window, else closed (templates only).
 */
export function windowStatus(
  window: { lastInboundAt: string | null; freeEntryUntil: string | null },
  now: string,
  windows: WorkflowDef['windows']
): WindowStatus {
  const ws = windowState(window, now, windows);
  if (ws.inFreeEntry && window.freeEntryUntil)
    return { kind: 'freeEntry', until: window.freeEntryUntil };
  if (ws.inService && window.lastInboundAt)
    return {
      kind: 'open',
      until: new Date(
        toMs(window.lastInboundAt) + windows.serviceHours * 3_600_000
      ).toISOString(),
    };
  return { kind: 'closed' };
}

export type TimerLabel =
  | 'docsReminder'
  | 'nudge'
  | 'reengage'
  | 'autoClose'
  | 'expiry'
  | 'thankYou'
  | 'other';

/** What a pending timer will do, read from its definition in the workflow. */
export function timerLabel(def: WorkflowDef, timer: Timer): TimerLabel {
  const td = def.states[timer.state]?.timers?.find(
    (t) => t.kind === timer.kind
  );
  if (!td) return 'other';
  if (td.anchor === 'validUntil') return 'expiry';
  const to = td.then.to;
  if (to === 'RE_ENGAGE') return 'reengage';
  if (to && def.states[to]?.terminal) return 'autoClose';
  if (timer.kind.startsWith('DOCS_REMINDER')) return 'docsReminder';
  if (def.states[timer.state]?.terminal) return 'thankYou';
  return 'nudge';
}

/** The soonest pending timer (ties keep the first), or null. */
export function nextTimer(timers: readonly Timer[]): Timer | null {
  let best: Timer | null = null;
  for (const t of timers)
    if (!best || toMs(t.fireAt) < toMs(best.fireAt)) best = t;
  return best;
}

/** The last `n` history entries, newest first. */
export function recentHistory(
  history: readonly HistoryEntry[],
  n = 5
): HistoryEntry[] {
  return history.slice(-n).reverse();
}

export interface DecisionOption {
  decision: AdvisorDecision;
  /** CLOSE: the engine rejects it without a reason code. */
  needsReason: boolean;
  /** Enters (or stays in) a state with a quote/offer validity: an optional "Valid until". */
  acceptsValidUntil: boolean;
}

/** The handler the engine would run for `decision` (globalAdvisor, then the PARKED reason's, then the state's). */
function advisorTransition(
  def: WorkflowDef,
  sd: StateDef,
  decision: string,
  parkedReason: string | null
): TransitionDef | undefined {
  return (
    def.globalAdvisor[decision] ??
    (parkedReason
      ? sd.byReason?.[parkedReason]?.advisor?.[decision]
      : undefined) ??
    sd.advisor?.[decision]
  );
}

/**
 * The advisor buttons for a file: the decisions its state handles
 * (`advisorDecisionsFor`, the server's own check), minus those limited
 * to other products, each with what it asks for.
 */
export function decisionOptions(
  def: WorkflowDef,
  file: { state: string; product: Product | null; parkedReason: string | null }
): DecisionOption[] {
  const sd = def.states[file.state];
  if (!sd) return [];
  const out: DecisionOption[] = [];
  for (const decision of advisorDecisionsFor(
    def,
    file.state,
    file.parkedReason
  )) {
    const t = advisorTransition(def, sd, decision, file.parkedReason);
    if (!t) continue;
    if (
      t.onlyProducts &&
      !(file.product && t.onlyProducts.includes(file.product))
    )
      continue;
    const target = t.to ? def.states[t.to] : sd;
    out.push({
      decision,
      needsReason: (t.guards ?? []).includes('reasonRequired'),
      acceptsValidUntil: !!target?.validity,
    });
  }
  return out;
}

/**
 * Reason codes an advisor may close with: the workflow's own NOT_WON
 * closing reasons. Not the opt-out's — that one belongs to the consent
 * register (the customer's STOP), and an advisor who is asked to stop
 * marks the customer do-not-contact instead.
 */
export function closeReasons(def: WorkflowDef): string[] {
  const optOutReason = def.states[def.optOut.to]?.outcome?.reason;
  const out = new Set<string>();
  for (const sd of Object.values(def.states)) {
    const r = sd.outcome?.reason;
    if (
      sd.terminal &&
      sd.outcome?.kind === 'NOT_WON' &&
      r &&
      !r.startsWith('$') &&
      r !== optOutReason
    )
      out.add(r);
  }
  return [...out];
}

/** A `YYYY-MM-DD` date input as the end of that day, local time (ISO), or null. */
export function validUntilFromDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface ConsentState {
  marketing_opt_in_at: string | null;
  opted_out_at: string | null;
  do_not_contact_at: string | null;
}

/** Why "Start journey" is disabled (the start route's own 409 order), or null. */
export function startBlocker(
  c: ConsentState
): 'optedOut' | 'doNotContact' | 'noOptIn' | null {
  if (c.opted_out_at) return 'optedOut';
  if (c.do_not_contact_at) return 'doNotContact';
  if (!c.marketing_opt_in_at) return 'noOptIn';
  return null;
}

/**
 * The contacts patch that withdraws a marketing opt-in. Both columns:
 * the consent guard needs a source only while the stamp is set, and a
 * source left behind would describe an opt-in that no longer exists.
 * Any agent who can see the contact may write it (086's guard).
 */
export const WITHDRAW_OPT_IN = {
  marketing_opt_in_at: null,
  marketing_opt_in_source: null,
} as const;

/** Sources an agent records an opt-in with (`marketing_opt_in_source`). */
export const OPT_IN_SOURCES = [
  'verbal',
  'written_form',
  'whatsapp_message',
  'website',
] as const;

const API_ERROR_CODES = new Set([
  'DECISION_NOT_AVAILABLE',
  'REASON_REQUIRED',
  'CONFLICT',
  'DUPLICATE',
  'OPTED_OUT',
  'DO_NOT_CONTACT',
  'NO_MARKETING_OPT_IN',
  'JOURNEYS_DISABLED',
  'UNKNOWN_WORKFLOW',
  'WRONG_PRODUCT',
  'NO_CONSENT',
  'WINDOW_CLOSED',
  'CAP_REACHED',
]);

/** `Journeys.errors` key for a journey route's error code ('generic' for any other). */
export function journeyErrorKey(code: string | null | undefined): string {
  return code && API_ERROR_CODES.has(code) ? code : 'generic';
}

/** `Journeys.consent.errors` key for a failed consent write (the guard trigger's errors). */
export function consentErrorKey(
  err: { code?: string | null; message?: string | null } | null
): 'sourceRequired' | 'adminOnly' | 'notAllowed' | 'generic' {
  if (err?.code === '23514') return 'sourceRequired';
  if (err?.code === '42501')
    return /admin/i.test(err.message ?? '') ? 'adminOnly' : 'notAllowed';
  return 'generic';
}
