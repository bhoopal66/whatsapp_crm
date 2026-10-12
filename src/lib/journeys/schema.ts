/**
 * Workflow definition types (the JSON in workflows/) and its validator.
 * The engine is generic over this shape; product copy lives in the Meta template pack.
 */
export const GUARDS = [
  'consentMarketing',
  'onceReengage',
  'onceOptinWelcome',
  'inWindow',
  'notOptedOut',
  'reasonRequired',
] as const;
export type GuardName = (typeof GUARDS)[number];
export type Category = 'MARKETING' | 'UTILITY' | 'SESSION';
export type Product = 'POS' | 'ACCOUNT' | 'LOAN';
export type OutcomeKind = 'WON' | 'NOT_WON' | 'PARKED';
export type CounterName = 'remindersThisStage' | 'reengageSent';
export type EventType =
  'INBOUND_TEXT' | 'BUTTON' | 'MEDIA' | 'ADVISOR' | 'TIMER' | 'START_COLD';
/** `$prev` = the file's prevOpenState. */
export const PREV = '$prev';
/** Outcome reason taken from the ADVISOR event's reasonCode. */
export const EVENT_REASON = '$event.reasonCode';

/** WhatsApp PHONE_NUMBER button: opens the customer's dialler; no webhook event (the engine ignores it). */
export interface PhoneButton {
  label: string;
  number: string;
}
export interface TemplateDef {
  category: Category;
  buttons: string[];
  variables: string[];
  product: string | null;
  /** At most one per template; `number` is a `{PLACEHOLDER}` or E.164. */
  phoneButton?: PhoneButton;
  /** SESSION messages only: "buttons" (default, max 3 reply buttons) or "list" (interactive list, max 10 rows). */
  interactive?: 'buttons' | 'list';
}
export interface SendDef {
  /** May contain `{product}` (resolved via `products`). Optional when `overrides` covers every product. */
  template?: string;
  overrides?: Partial<Record<Product, string>>;
  /** ctx.variant → template (host-chosen variant, e.g. intro/switch offer). Falls back to `template`. */
  variants?: Record<string, string>;
  when?: 'inWindow' | 'outOfWindow';
  guards?: GuardName[];
  counter?: CounterName;
}
export interface TaskDef {
  kind: string;
  note: string;
}
export interface TransitionDef {
  guards?: GuardName[];
  /** 'reject' → step returns an error; a state id → go there; default 'warn' → warning, no-op. */
  onGuardFail?: string;
  setProduct?: Product;
  send?: SendDef[];
  task?: TaskDef;
  startNewJourney?: boolean;
  to?: string;
  /** Outcome reason when `to` is a PARKED state. */
  reason?: string;
  /** Applies only to files with one of these products; any other product → step rejects (WRONG_PRODUCT). */
  onlyProducts?: Product[];
}
export interface TimerDef {
  kind: string;
  anchor: 'enter' | 'silence' | 'validUntil';
  after: string;
  then: TransitionDef;
}
/** Event handlers; on a state they apply always, inside `byReason` only while the file's PARKED reason matches. */
export interface Handlers {
  buttons?: Record<string, TransitionDef>;
  advisor?: Record<string, TransitionDef>;
  onMedia?: TransitionDef;
  onInbound?: TransitionDef;
}
export interface StateDef {
  terminal?: boolean;
  outcome?: { kind: OutcomeKind; reason?: string };
  /** Entering from a state without keepsPrev records that state as prevOpenState. */
  keepsPrev?: boolean;
  guards?: GuardName[];
  onGuardFail?: string;
  onEnter?: { send?: SendDef[]; task?: TaskDef };
  buttons?: Record<string, TransitionDef>;
  advisor?: Record<string, TransitionDef>;
  onMedia?: TransitionDef;
  onInbound?: TransitionDef;
  /** Keyed by the file's PARKED outcome reason; these handlers take precedence over the state's own. */
  byReason?: Record<string, Handlers>;
  timers?: TimerDef[];
  /**
   * The state presents a time-limited quote/offer. `slot` names the file's `validUntil` entry: an ADVISOR event entering
   * the state (or handled in it with a validUntil) re-issues it; any other (re-)entry at/after it takes `onLapse`
   * instead of entering, and otherwise re-arms the state's `validUntil` timers from the stored instant.
   */
  validity?: { slot: string; onLapse: TransitionDef };
}
export interface EntryDef extends TransitionDef {
  on: EventType[];
}
export interface WorkflowDef {
  id: string;
  version: number;
  products: Record<Product, string>;
  windows: { serviceHours: number; freeEntryHours: number };
  quietHours: {
    utcOffsetMinutes: number;
    start: string;
    end: string;
    appliesTo: EventType[];
  };
  caps: {
    remindersThisStage: number;
    reengageSent: number;
    paidAfterParked: number;
  };
  optOut: {
    keywords: string[];
    send: SendDef;
    keepStates: string[];
    to: string;
  };
  resubscribe: { keywords: string[] };
  /** Global CALL_ME_BACK quick-reply handler (any state; never changes state). */
  callback?: { payload: string; ack: SendDef; dueIn: string; throttle: string };
  globalAdvisor: Record<string, TransitionDef>;
  entries: Record<string, EntryDef>;
  states: Record<string, StateDef>;
  templates: Record<string, TemplateDef>;
}

const CATEGORIES: Category[] = ['MARKETING', 'UTILITY', 'SESSION'];
const ANCHORS = ['enter', 'silence', 'validUntil'];
/** WhatsApp template limit: 10 buttons in total (quick replies + call-to-action). */
export const MAX_TEMPLATE_BUTTONS = 10;
export const MAX_SESSION_REPLY_BUTTONS = 3;
export const MAX_SESSION_LIST_ROWS = 10;
const PHONE_NUMBER = /^(\{[A-Z][A-Z0-9_]*\}|\+[1-9]\d{6,14})$/;

/** Every template name a send can resolve to (all products, all variants). */
export function templateNames(def: WorkflowDef, s: SendDef): string[] {
  const out = new Set<string>();
  for (const p of Object.keys(def.products) as Product[]) {
    const o = s.overrides?.[p];
    if (o) out.add(o);
    else if (s.template)
      out.add(s.template.replace('{product}', def.products[p]));
  }
  for (const v of Object.values(s.variants ?? {})) out.add(v);
  return [...out];
}

interface Site {
  label: string;
  state: string | null;
  t: TransitionDef;
  stateGuards: GuardName[];
}

function sites(def: WorkflowDef): Site[] {
  const out: Site[] = [];
  for (const [k, e] of Object.entries(def.entries))
    out.push({ label: `entries.${k}`, state: null, t: e, stateGuards: [] });
  for (const [k, t] of Object.entries(def.globalAdvisor))
    out.push({ label: `globalAdvisor.${k}`, state: null, t, stateGuards: [] });
  out.push({
    label: 'optOut',
    state: null,
    t: { send: [def.optOut.send], to: def.optOut.to },
    stateGuards: [],
  });
  if (def.callback)
    out.push({
      label: 'callback',
      state: null,
      t: { send: [def.callback.ack] },
      stateGuards: [],
    });
  for (const [s, sd] of Object.entries(def.states)) {
    if (sd.onEnter)
      out.push({
        label: `${s}.onEnter`,
        state: s,
        t: { send: sd.onEnter.send },
        stateGuards: sd.guards ?? [],
      });
    for (const [prefix, h] of [
      [s, sd],
      ...Object.entries(sd.byReason ?? {}).map(
        ([r, rh]) => [`${s}.byReason.${r}`, rh] as const
      ),
    ] as const) {
      for (const [k, t] of Object.entries(h.buttons ?? {}))
        out.push({
          label: `${prefix}.buttons.${k}`,
          state: s,
          t,
          stateGuards: [],
        });
      for (const [k, t] of Object.entries(h.advisor ?? {}))
        out.push({
          label: `${prefix}.advisor.${k}`,
          state: s,
          t,
          stateGuards: [],
        });
      if (h.onMedia)
        out.push({
          label: `${prefix}.onMedia`,
          state: s,
          t: h.onMedia,
          stateGuards: [],
        });
      if (h.onInbound)
        out.push({
          label: `${prefix}.onInbound`,
          state: s,
          t: h.onInbound,
          stateGuards: [],
        });
    }
    for (const tm of sd.timers ?? [])
      out.push({
        label: `${s}.timers.${tm.kind}`,
        state: s,
        t: tm.then,
        stateGuards: [],
      });
    if (sd.onGuardFail)
      out.push({
        label: `${s}.onGuardFail`,
        state: s,
        t: { to: sd.onGuardFail },
        stateGuards: [],
      });
    if (sd.validity)
      out.push({
        label: `${s}.validity.onLapse`,
        state: s,
        t: sd.validity.onLapse,
        stateGuards: [],
      });
  }
  return out;
}

const targetsOf = (t: TransitionDef): string[] =>
  [t.to, t.onGuardFail].filter(
    (x): x is string => !!x && x !== 'reject' && x !== 'warn'
  );

function reachable(def: WorkflowDef, entryKeys: string[]): Set<string> {
  const all = sites(def);
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (s: string) => {
    if (s !== PREV && def.states[s] && !seen.has(s)) {
      seen.add(s);
      queue.push(s);
    }
  };
  for (const k of entryKeys) {
    const e = def.entries[k];
    if (e) targetsOf(e).forEach(push);
  }
  const globals = all
    .filter((x) => x.state === null && !x.label.startsWith('entries.'))
    .flatMap((x) => targetsOf(x.t));
  while (queue.length) {
    const s = queue.shift()!;
    for (const x of all) if (x.state === s) targetsOf(x.t).forEach(push);
    if (!def.states[s]?.terminal) globals.forEach(push);
  }
  return seen;
}

/** Returns a list of precise errors; empty means valid. */
export function validateWorkflow(def: WorkflowDef): string[] {
  const errors: string[] = [];
  const all = sites(def);
  const exists = (s: string) => s === PREV || !!def.states[s];

  for (const [name, t] of Object.entries(def.templates)) {
    if (!CATEGORIES.includes(t.category))
      errors.push(`templates.${name}: invalid category "${t.category}"`);
    // JSON boundary: a hand-edited registry may carry an array here.
    const phones: unknown[] =
      t.phoneButton === undefined
        ? []
        : Array.isArray(t.phoneButton)
          ? t.phoneButton
          : [t.phoneButton];
    if (phones.length > 1)
      errors.push(
        `templates.${name}: at most one phone button per template (has ${phones.length})`
      );
    for (const pb of phones) {
      const n = (pb as Partial<PhoneButton> | null)?.number;
      if (typeof n !== 'string' || !PHONE_NUMBER.test(n))
        errors.push(
          `templates.${name}: phone button number "${String(n)}" is not a {PLACEHOLDER} or E.164`
        );
    }
    const total = t.buttons.length + phones.length;
    if (t.category === 'SESSION') {
      // Session (non-template) interactive messages: reply buttons max 3, list rows max 10; no phone button.
      const max =
        t.interactive === 'list'
          ? MAX_SESSION_LIST_ROWS
          : MAX_SESSION_REPLY_BUTTONS;
      if (t.buttons.length > max)
        errors.push(
          `templates.${name}: SESSION ${t.interactive ?? 'buttons'} message has ${t.buttons.length} options; WhatsApp allows ${max}${t.interactive === 'list' ? '' : ' (use interactive: "list")'}`
        );
      if (phones.length)
        errors.push(
          `templates.${name}: SESSION messages cannot carry a phone button`
        );
    } else if (t.interactive)
      errors.push(
        `templates.${name}: "interactive" applies to SESSION messages only`
      );
    if (total > MAX_TEMPLATE_BUTTONS)
      errors.push(
        `templates.${name}: ${total} buttons exceed WhatsApp's ${MAX_TEMPLATE_BUTTONS} per template`
      );
  }
  if (def.callback) {
    for (const k of ['dueIn', 'throttle'] as const)
      if (!/^\d+[dhm]$/.test(def.callback[k]))
        errors.push(`callback.${k}: bad duration "${def.callback[k]}"`);
    for (const n of templateNames(def, def.callback.ack))
      if (def.templates[n] && def.templates[n].category !== 'SESSION')
        errors.push(`callback.ack: "${n}" must be SESSION`);
  }

  for (const x of all) {
    for (const target of targetsOf(x.t))
      if (!exists(target))
        errors.push(`${x.label}: target "${target}" is not a state`);
    for (const g of [
      ...(x.t.guards ?? []),
      ...(x.t.send ?? []).flatMap((s) => s.guards ?? []),
    ])
      if (!GUARDS.includes(g)) errors.push(`${x.label}: unknown guard "${g}"`);
    for (const s of x.t.send ?? [])
      for (const n of templateNames(def, s))
        if (!def.templates[n])
          errors.push(
            `${x.label}: template "${n}" is not in the template registry`
          );
    for (const p of x.t.onlyProducts ?? [])
      if (!(p in def.products))
        errors.push(`${x.label}: unknown product "${p}" in onlyProducts`);
    const into = x.t.to ? def.states[x.t.to] : undefined;
    if (into?.outcome?.kind === 'PARKED' && !x.t.reason && !into.outcome.reason)
      errors.push(
        `${x.label}: transition into PARKED state "${x.t.to}" has no reason`
      );
  }
  for (const s of def.optOut.keepStates)
    if (!def.states[s]) errors.push(`optOut.keepStates: "${s}" is not a state`);

  const reach = reachable(def, Object.keys(def.entries));
  for (const [s, sd] of Object.entries(def.states)) {
    if (!reach.has(s)) errors.push(`${s}: unreachable from any entry`);
    for (const g of sd.guards ?? [])
      if (!GUARDS.includes(g)) errors.push(`${s}.guards: unknown guard "${g}"`);
    for (const tm of sd.timers ?? []) {
      if (!/^\d+[dhm]$/.test(tm.after))
        errors.push(`${s}.timers.${tm.kind}: bad duration "${tm.after}"`);
      if (!ANCHORS.includes(tm.anchor))
        errors.push(`${s}.timers.${tm.kind}: bad anchor "${tm.anchor}"`);
    }
    if (sd.terminal) {
      const k = sd.outcome?.kind;
      if (k !== 'WON' && k !== 'NOT_WON')
        errors.push(`${s}: terminal state needs outcome WON or NOT_WON`);
      if (k === 'NOT_WON' && !sd.outcome?.reason)
        errors.push(`${s}: NOT_WON terminal state has no reason code`);
      if (sd.outcome?.reason === EVENT_REASON)
        for (const x of all.filter(
          (y) => y.t.to === s && !(y.t.guards ?? []).includes('reasonRequired')
        ))
          errors.push(
            `${x.label}: closes into "${s}" (reason from event) without reasonRequired guard`
          );
      for (const x of all.filter((y) => y.state === s && y.t.to))
        errors.push(`${x.label}: terminal state cannot transition`);
    } else {
      if (sd.outcome && sd.outcome.kind !== 'PARKED')
        errors.push(
          `${s}: non-terminal state cannot have outcome ${sd.outcome.kind}`
        );
      const exits = all.filter(
        (y) =>
          y.state === s &&
          !y.label.endsWith('.onEnter') &&
          targetsOf(y.t).length > 0
      );
      if (exits.length === 0)
        errors.push(
          `${s}: non-terminal state has no way out (button, advisor event or timer)`
        );
    }
  }

  // §5: MARKETING needs an explicit consent guard on any path an INBOUND contact can take.
  const inboundReach = reachable(
    def,
    Object.keys(def.entries).filter((k) => k === 'INBOUND')
  );
  for (const x of all) {
    if (x.state !== null && !inboundReach.has(x.state)) continue;
    for (const s of x.t.send ?? []) {
      const guarded = [
        ...x.stateGuards,
        ...(x.t.guards ?? []),
        ...(s.guards ?? []),
      ].includes('consentMarketing');
      for (const n of templateNames(def, s))
        if (def.templates[n]?.category === 'MARKETING' && !guarded)
          errors.push(
            `${x.label}: MARKETING template "${n}" sent without consentMarketing guard`
          );
    }
  }
  return errors;
}
