/**
 * Pure journey engine: step(def, file, event, now, ctx) → { file, actions, warnings, error? }.
 * No I/O, no clock, no randomness; inputs are never mutated (works on a structured clone).
 */
import {
  EVENT_REASON,
  PREV,
  templateNames,
  type GuardName,
  type Handlers,
  type Product,
  type SendDef,
  type StateDef,
  type TaskDef,
  type TransitionDef,
  type WorkflowDef,
} from './schema';
import {
  NEW_STATE,
  type Action,
  type JourneyEvent,
  type JourneyFile,
  type StepContext,
  type StepResult,
  type Warning,
} from './types';
import { isBillable, windowState } from './policy';
import { addMs, parseDuration, quietHoursNotBefore, toMs } from './time';

/** Warning code emitted when a guard fails. */
const GUARD_WARNING: Record<GuardName, string> = {
  consentMarketing: 'NO_CONSENT',
  notOptedOut: 'NO_CONSENT',
  onceOptinWelcome: 'CAP_REACHED',
  onceReengage: 'CAP_REACHED',
  inWindow: 'WINDOW_CLOSED',
  reasonRequired: 'REASON_REQUIRED',
};

export function newFile(init: {
  id: string;
  contactId: string;
  workspaceId: string;
  product?: Product | null;
}): JourneyFile {
  return {
    id: init.id,
    contactId: init.contactId,
    workspaceId: init.workspaceId,
    product: init.product ?? null,
    entry: null,
    state: NEW_STATE,
    prevOpenState: null,
    window: { lastInboundAt: null, freeEntryUntil: null },
    counters: {
      reengageSent: 0,
      remindersThisStage: 0,
      paidSends: 0,
      paidAfterParked: 0,
    },
    timers: [],
    validUntil: {},
    outcome: null,
    optedOut: false,
    history: [],
    version: 0,
  };
}

/** Case-, diacritic- and surrounding-punctuation-insensitive keyword form. */
export function normalizeKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/^[\p{P}\p{Z}\s]+|[\p{P}\p{Z}\s]+$/gu, '')
    .toUpperCase()
    .normalize('NFC');
}

export function step(
  def: WorkflowDef,
  file: JourneyFile,
  event: JourneyEvent,
  now: string,
  ctx: StepContext
): StepResult {
  const f = structuredClone(file);
  f.validUntil ??= {}; // files persisted before validity slots existed
  const run = new Step(def, f, event, now, ctx);
  run.exec();
  if (run.error) return { file, actions: [], warnings: [], error: run.error };
  return { file: run.f, actions: run.actions, warnings: run.warnings };
}

/** The contact-level cap marker is emitted immediately before this template is sent. */
const OPTIN_WELCOME = 'taamul_optin_welcome';

const isInbound = (e: JourneyEvent) =>
  e.type === 'INBOUND_TEXT' || e.type === 'BUTTON' || e.type === 'MEDIA';

class Step {
  actions: Action[] = [];
  warnings: Warning[] = [];
  error?: Warning;
  private entered = false;

  constructor(
    readonly def: WorkflowDef,
    readonly f: JourneyFile,
    readonly event: JourneyEvent,
    readonly now: string,
    readonly ctx: StepContext
  ) {}

  exec(): void {
    const { f, event } = this;
    if (isInbound(event)) this.refreshWindow();
    const kw = event.type === 'INBOUND_TEXT' ? this.keywords(event.text) : null;
    if (kw) {
      const ksd = this.def.states[f.state];
      if (ksd && !this.entered) {
        this.rearmAfterEvent(ksd);
        if (kw === 'START') this.restoreTimers(ksd);
      }
      return;
    }
    if (f.state === NEW_STATE) return this.start();
    const sd = this.def.states[f.state];
    if (!sd)
      return this.warn(
        'UNKNOWN_STATE',
        `file is in unknown state "${f.state}"`
      );
    // Global CALL_ME_BACK (any state, like the opt-out keywords): never changes state; re-arms silence like any inbound.
    if (
      event.type === 'BUTTON' &&
      this.def.callback &&
      event.payload === this.def.callback.payload
    ) {
      this.callback(sd);
      this.rearmAfterEvent(sd);
      return;
    }
    // While parked for a reason with its own handlers, those take precedence (e.g. a lapsed quote/offer).
    const rh: Handlers =
      (f.outcome?.kind === 'PARKED'
        ? sd.byReason?.[f.outcome.reason]
        : undefined) ?? {};

    if (event.type === 'ADVISOR') {
      if (sd.terminal)
        return this.warn(
          'FILE_CLOSED',
          `ADVISOR ${event.decision} ignored: file is closed`
        );
      const t =
        this.def.globalAdvisor[event.decision] ??
        rh.advisor?.[event.decision] ??
        sd.advisor?.[event.decision];
      if (!t)
        return this.warn(
          'UNHANDLED_ADVISOR',
          `${f.state} has no handler for ADVISOR ${event.decision}`
        );
      this.transition(t, `ADVISOR:${event.decision}`);
    } else if (event.type === 'BUTTON') {
      const t =
        rh.buttons?.[event.payload] ??
        rh.onInbound ??
        sd.buttons?.[event.payload] ??
        sd.onInbound;
      if (t) this.transition(t, `BUTTON:${event.payload}`);
      else
        this.warn(
          'UNHANDLED_BUTTON',
          `${f.state} has no handler for button ${event.payload}`
        );
    } else if (event.type === 'MEDIA') {
      const t = rh.onMedia ?? rh.onInbound ?? sd.onMedia ?? sd.onInbound;
      if (t) this.transition(t, 'MEDIA');
    } else if (event.type === 'INBOUND_TEXT') {
      const t = rh.onInbound ?? sd.onInbound;
      if (t) this.transition(t, 'INBOUND_TEXT');
    } else if (event.type === 'TIMER') {
      this.timer(sd, event.kind);
    } else {
      return this.warn(
        'ALREADY_STARTED',
        'START_COLD refused: journey already started'
      );
    }
    if (!this.entered && !this.error) this.rearmAfterEvent(sd);
  }

  // ── window, keywords, entry ────────────────────────────────────────────────
  private refreshWindow(): void {
    const e = this.event as Extract<JourneyEvent, { at: string }>;
    const last = this.f.window.lastInboundAt;
    if (!last || toMs(e.at) > toMs(last)) this.f.window.lastInboundAt = e.at;
    if (e.type === 'INBOUND_TEXT' && e.freeEntry) {
      const until = addMs(e.at, this.def.windows.freeEntryHours * 3_600_000);
      const cur = this.f.window.freeEntryUntil;
      this.f.window.freeEntryUntil =
        cur && toMs(cur) > toMs(until) ? cur : until;
    }
  }

  /** Opt-out / re-subscribe keywords; the keyword kind when the event was consumed. */
  private keywords(text: string): 'STOP' | 'START' | null {
    const { def, f } = this;
    const k = normalizeKeyword(text);
    if (def.optOut.keywords.some((w) => normalizeKeyword(w) === k)) {
      this.send(def.optOut.send);
      f.optedOut = true;
      this.actions.push({ type: 'SET_OPT_OUT', optedOut: true });
      const sd = def.states[f.state];
      // An open application keeps its non-marketing timers (docs reminders, silence close).
      if (sd && !sd.terminal && def.optOut.keepStates.includes(f.state))
        this.cancelMarketingTimers(sd);
      else {
        this.cancelTimers();
        if (!sd?.terminal) this.enter(def.optOut.to, 'OPT_OUT');
      }
      return 'STOP';
    }
    if (
      def.resubscribe.keywords.some((w) => normalizeKeyword(w) === k) &&
      (f.optedOut || this.ctx.consent.optedOut)
    ) {
      f.optedOut = false;
      this.actions.push({ type: 'SET_OPT_OUT', optedOut: false });
      return 'START';
    }
    return null;
  }

  /** CALL_ME_BACK: advisor task + REQUEST_CALLBACK (module 015) + SESSION ack; DNC → task only; throttled per file. */
  private callback(sd: StateDef): void {
    const { def, f, now, ctx } = this;
    const cb = def.callback!;
    if (ctx.consent.doNotContact) {
      this.actions.push({
        type: 'ADVISOR_TASK',
        kind: 'CALLBACK_BLOCKED_DNC',
        dueAt: now,
        note: 'Customer tapped Call me back but is on do-not-contact — do not call; review the DNC flag',
      });
      return;
    }
    const notBefore = quietHoursNotBefore(now, def.quietHours);
    const variant = notBefore ? 'OUT_OF_HOURS' : 'IN_HOURS';
    if (
      f.lastCallbackAt &&
      toMs(now) < toMs(f.lastCallbackAt) + parseDuration(cb.throttle)
    ) {
      this.warn(
        'CALLBACK_THROTTLED',
        `callback already requested at ${f.lastCallbackAt} (one per ${cb.throttle})`
      );
    } else {
      f.lastCallbackAt = now;
      const dueAt = notBefore ?? addMs(now, parseDuration(cb.dueIn));
      const closed = sd.terminal ? ' (file closed — no automatic call)' : '';
      this.actions.push({
        type: 'ADVISOR_TASK',
        kind: 'CALLBACK',
        dueAt,
        note: `Customer tapped Call me back — call via Linkus click-to-call (module 015)${closed}`,
      });
      if (!sd.terminal)
        this.actions.push({
          type: 'REQUEST_CALLBACK',
          contactId: f.contactId,
          fileId: f.id,
          ...(notBefore ? { notBefore } : {}),
        });
    }
    this.send(cb.ack, variant);
  }

  private start(): void {
    const found = Object.entries(this.def.entries).find(([, e]) =>
      e.on.includes(this.event.type)
    );
    if (!found)
      return this.warn(
        'NOT_STARTED',
        `${this.event.type} ignored: journey not started`
      );
    const [key, entry] = found;
    const failed = this.failedGuard(entry.guards);
    if (failed)
      return this.warn(
        GUARD_WARNING[failed],
        `${key} entry refused: guard ${failed} failed`
      );
    this.f.entry = key as 'INBOUND' | 'COLD';
    this.transition(entry, `ENTRY:${key}`);
  }

  // ── transitions and states ─────────────────────────────────────────────────
  private transition(t: TransitionDef, cause: string): void {
    if (
      t.onlyProducts &&
      !(this.f.product && t.onlyProducts.includes(this.f.product))
    ) {
      this.error = {
        code: 'WRONG_PRODUCT',
        message: `${cause}: applies to ${t.onlyProducts.join('/')} only, file product is ${this.f.product ?? 'none'}`,
      };
      return;
    }
    const failed = this.failedGuard(t.guards);
    if (failed) {
      const msg = `${cause}: guard ${failed} failed`;
      if (t.onGuardFail === 'reject') {
        this.error = { code: GUARD_WARNING[failed], message: msg };
        return;
      }
      if (t.onGuardFail && t.onGuardFail !== 'warn')
        return this.enter(t.onGuardFail, `${cause} [guard ${failed}]`);
      return this.warn(GUARD_WARNING[failed], msg);
    }
    if (t.setProduct) this.f.product = t.setProduct;
    for (const s of t.send ?? []) this.send(s);
    if (t.task) this.task(t.task);
    if (t.startNewJourney)
      this.actions.push({
        type: 'START_NEW_JOURNEY',
        contactId: this.f.contactId,
        entry: 'INBOUND',
        cause,
      });
    if (t.to) this.enter(t.to, cause, t.reason);
  }

  private enter(target: string, cause: string, reason?: string): void {
    const { def, f } = this;
    if (target === PREV) {
      if (!f.prevOpenState)
        return this.warn(
          'NO_PREV_STATE',
          `${cause}: no prevOpenState to return to`
        );
      target = f.prevOpenState;
    }
    const td = def.states[target];
    if (!td)
      return this.warn('UNKNOWN_STATE', `${cause}: unknown state "${target}"`);
    const failed = this.failedGuard(td.guards);
    if (failed) {
      this.warn(GUARD_WARNING[failed], `${target} guard ${failed} failed`);
      if (td.onGuardFail)
        this.enter(td.onGuardFail, `${cause} [${target} guard ${failed}]`);
      return;
    }
    if (td.validity) {
      const { slot, onLapse } = td.validity;
      if (this.event.type === 'ADVISOR') {
        // An advisor decision entering the state (re-)issues the quote/offer; no validUntil → none on file.
        if (this.event.validUntil) f.validUntil[slot] = this.event.validUntil;
        else delete f.validUntil[slot];
      } else if (
        f.validUntil[slot] &&
        toMs(this.now) >= toMs(f.validUntil[slot]!)
      ) {
        return this.transition(onLapse, `${cause} [${target} validity lapsed]`);
      }
    }
    const from = f.state;
    if (td.keepsPrev) {
      if (!def.states[from]?.keepsPrev) f.prevOpenState = from;
    } else f.prevOpenState = null;

    if (td.terminal && td.outcome && td.outcome.kind !== 'PARKED') {
      const r =
        td.outcome.reason === EVENT_REASON && this.event.type === 'ADVISOR'
          ? this.event.reasonCode
          : td.outcome.reason;
      f.outcome = { kind: td.outcome.kind, reason: r ?? 'UNSPECIFIED' };
    } else if (td.outcome?.kind === 'PARKED') {
      f.outcome = {
        kind: 'PARKED',
        reason: reason ?? td.outcome.reason ?? 'UNSPECIFIED',
      };
      f.counters.paidAfterParked = 0;
    } else if (!td.keepsPrev) f.outcome = null;

    f.state = target;
    f.history.push({ at: this.now, from, to: target, cause });
    this.entered = true;
    this.cancelTimers();
    f.counters.remindersThisStage = 0;
    if (td.terminal && f.outcome && f.outcome.kind !== 'PARKED')
      this.actions.push({
        type: 'CLOSE',
        outcome: f.outcome.kind,
        reason: f.outcome.reason,
      });
    for (const s of td.onEnter?.send ?? []) this.send(s);
    if (td.onEnter?.task) this.task(td.onEnter.task);
    for (const tm of td.timers ?? [])
      this.arm(target, tm.kind, tm.anchor, tm.after);
  }

  // ── timers ─────────────────────────────────────────────────────────────────
  private timer(sd: StateDef, kind: string): void {
    const { f } = this;
    const i = f.timers.findIndex((t) => t.kind === kind && t.state === f.state);
    const tm = sd.timers?.find((t) => t.kind === kind);
    if (i < 0 || !tm)
      return this.warn(
        'STALE_TIMER',
        `timer ${kind} is not pending in ${f.state}`
      );
    if (toMs(this.event.at) < toMs(f.timers[i]!.fireAt))
      return this.warn(
        'STALE_TIMER',
        `timer ${kind} fired at ${this.event.at}, pending one is due ${f.timers[i]!.fireAt}`
      );
    f.timers.splice(i, 1);
    this.transition(tm.then, `TIMER:${kind}`);
  }

  private arm(
    state: string,
    kind: string,
    anchor: string,
    after: string
  ): void {
    let base: string | undefined;
    if (anchor === 'enter') base = this.now;
    else if (anchor === 'silence') base = this.silenceAnchor();
    else base = this.validUntilOf(state);
    if (base) this.setTimer(state, kind, addMs(base, parseDuration(after)));
  }

  private setTimer(state: string, kind: string, fireAt: string): void {
    if (this.f.timers.some((t) => t.kind === kind)) {
      this.f.timers = this.f.timers.filter((t) => t.kind !== kind);
      this.actions.push({ type: 'CANCEL_TIMERS', kinds: [kind] });
    }
    this.f.timers.push({ kind, fireAt, state });
    this.actions.push({ type: 'SET_TIMER', kind, fireAt });
  }

  /** The stored validUntil of a validity state; else (legacy) the ADVISOR event's. */
  private validUntilOf(state: string): string | undefined {
    const slot = this.def.states[state]?.validity?.slot;
    if (slot) return this.f.validUntil[slot];
    return this.event.type === 'ADVISOR' ? this.event.validUntil : undefined;
  }

  /** Silence timers count from the later of state entry and the last inbound message. */
  private silenceAnchor(): string {
    const entered = this.f.history.at(-1)?.at ?? this.now;
    const last = this.f.window.lastInboundAt;
    return last && toMs(last) > toMs(entered) ? last : entered;
  }

  /** Staying in a state: inbound re-arms pending silence timers; a validUntil arms validUntil timers. */
  private rearmAfterEvent(sd: StateDef): void {
    if (sd.validity && this.event.type === 'ADVISOR' && this.event.validUntil)
      this.f.validUntil[sd.validity.slot] = this.event.validUntil;
    for (const tm of sd.timers ?? []) {
      const pending = this.f.timers.some((t) => t.kind === tm.kind);
      if (tm.anchor === 'silence' && pending && isInbound(this.event))
        this.arm(this.f.state, tm.kind, tm.anchor, tm.after);
      if (
        tm.anchor === 'validUntil' &&
        this.event.type === 'ADVISOR' &&
        this.event.validUntil
      )
        this.arm(this.f.state, tm.kind, tm.anchor, tm.after);
    }
  }

  /** START: re-arm the state's timers that are not pending — silence from now, entry-anchored only if still due. */
  private restoreTimers(sd: StateDef): void {
    const enteredAt = this.f.history.at(-1)?.at ?? this.now;
    for (const tm of sd.timers ?? []) {
      if (this.f.timers.some((t) => t.kind === tm.kind)) continue;
      if (tm.anchor === 'silence')
        this.arm(this.f.state, tm.kind, tm.anchor, tm.after);
      if (tm.anchor !== 'enter') continue;
      const fireAt = addMs(enteredAt, parseDuration(tm.after));
      if (toMs(fireAt) > toMs(this.now))
        this.setTimer(this.f.state, tm.kind, fireAt);
    }
  }

  /** Opt-out inside an open application: drop only timers whose transition sends MARKETING. */
  private cancelMarketingTimers(sd: StateDef): void {
    const { def } = this;
    const marketing = (sd.timers ?? [])
      .filter((tm) =>
        (tm.then.send ?? []).some((s) =>
          templateNames(def, s).some(
            (n) => def.templates[n]?.category === 'MARKETING'
          )
        )
      )
      .map((tm) => tm.kind);
    const kinds = this.f.timers
      .filter((t) => marketing.includes(t.kind))
      .map((t) => t.kind);
    if (kinds.length === 0) return;
    this.f.timers = this.f.timers.filter((t) => !kinds.includes(t.kind));
    this.actions.push({ type: 'CANCEL_TIMERS', kinds });
  }

  private cancelTimers(): void {
    if (this.f.timers.length === 0) return;
    this.f.timers = [];
    this.actions.push({ type: 'CANCEL_TIMERS', all: true });
  }

  // ── sends (§5 policy) ──────────────────────────────────────────────────────
  private send(s: SendDef, variant?: string): void {
    const { def, f, ctx, now } = this;
    const ws = windowState(f.window, now, def.windows);
    if (s.when === 'inWindow' && !ws.open) return;
    if (s.when === 'outOfWindow' && ws.open) return;
    const name = this.resolveTemplate(s);
    if (!name)
      return this.warn(
        'NO_PRODUCT',
        `cannot resolve template ${s.template ?? ''} without a product`
      );
    const tpl = def.templates[name];
    if (!tpl)
      return this.warn(
        'UNREGISTERED_TEMPLATE',
        `template "${name}" is not in the registry`
      );
    const failed = this.failedGuard(s.guards);
    if (failed)
      return this.warn(
        GUARD_WARNING[failed],
        `${name} not sent: guard ${failed} failed`
      );
    const optedOut = f.optedOut || ctx.consent.optedOut;
    // Opt-out stops marketing only; service replies (SESSION) and UTILITY for an open application still go.
    if (optedOut && tpl.category === 'MARKETING')
      return this.warn(
        'OPTED_OUT',
        `${name} not sent: contact opted out of marketing`
      );
    if (tpl.category === 'MARKETING' && !ctx.consent.marketingOptIn)
      return this.warn('NO_CONSENT', `${name} not sent: no marketing opt-in`);
    if (tpl.category === 'SESSION' && !ws.open) {
      this.task({
        kind: 'TEMPLATE_NEEDED',
        note: `window closed — template needed (session message ${name})`,
      });
      return;
    }
    if (s.counter && f.counters[s.counter] >= def.caps[s.counter])
      return this.warn(
        'CAP_REACHED',
        `${name} not sent: ${s.counter} cap ${def.caps[s.counter]}`
      );
    const q = def.quietHours;
    const deferrable =
      q.appliesTo.includes(this.event.type) &&
      (isBillable(tpl.category, ws) || tpl.category === 'MARKETING');
    const notBefore = deferrable ? quietHoursNotBefore(now, q) : null;
    // Billing is decided at delivery time: a deferred send may land after a free window has closed.
    const billable = isBillable(
      tpl.category,
      notBefore ? windowState(f.window, notBefore, def.windows) : ws
    );
    const parked = f.outcome?.kind === 'PARKED';
    if (
      billable &&
      parked &&
      f.counters.paidAfterParked >= def.caps.paidAfterParked
    )
      return this.warn(
        'CAP_REACHED',
        `${name} not sent: paid-after-parked cap ${def.caps.paidAfterParked}`
      );
    if (name === OPTIN_WELCOME)
      this.actions.push({
        type: 'MARK_OPTIN_WELCOME_SENT',
        contactId: f.contactId,
      });
    this.actions.push({
      type: 'SEND',
      template: name,
      category: tpl.category,
      billable,
      ...(notBefore ? { notBefore } : {}),
      ...(variant ? { variant } : {}),
    });
    if (s.counter) f.counters[s.counter] += 1;
    if (billable) {
      f.counters.paidSends += 1;
      if (parked) f.counters.paidAfterParked += 1;
      this.actions.push({
        type: 'LOG_COST',
        template: name,
        category: tpl.category,
      });
    }
  }

  private resolveTemplate(s: SendDef): string | null {
    const v =
      this.ctx.variant !== undefined
        ? s.variants?.[this.ctx.variant]
        : undefined;
    if (v) return v;
    const p = this.f.product;
    if (p && s.overrides?.[p]) return s.overrides[p]!;
    if (!s.template) return null;
    if (!s.template.includes('{product}')) return s.template;
    return p ? s.template.replace('{product}', this.def.products[p]) : null;
  }

  // ── guards, tasks, warnings ────────────────────────────────────────────────
  private failedGuard(guards: GuardName[] | undefined): GuardName | null {
    for (const g of guards ?? []) if (!this.guard(g)) return g;
    return null;
  }

  private guard(g: GuardName): boolean {
    const { f, ctx, event, now, def } = this;
    switch (g) {
      case 'consentMarketing':
        return ctx.consent.marketingOptIn;
      case 'notOptedOut':
        return !f.optedOut && !ctx.consent.optedOut;
      case 'onceReengage':
        return f.counters.reengageSent < def.caps.reengageSent;
      case 'onceOptinWelcome':
        return !ctx.contactHasReceivedOptinWelcome;
      case 'inWindow':
        return windowState(f.window, now, def.windows).open;
      case 'reasonRequired':
        return event.type === 'ADVISOR' && !!event.reasonCode?.trim();
    }
  }

  private task(t: TaskDef): void {
    this.actions.push({
      type: 'ADVISOR_TASK',
      kind: t.kind,
      dueAt: this.now,
      note: t.note,
    });
  }

  private warn(code: string, message: string): void {
    this.warnings.push({ code, message });
  }
}
