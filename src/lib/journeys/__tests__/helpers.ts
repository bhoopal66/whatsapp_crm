import {
  SHIPPED_WORKFLOW,
  newFile,
  step,
  type Action,
  type ActionSink,
  type CommitResult,
  type JourneyEvent,
  type JourneyFile,
  type JourneyStore,
  type OutboxItem,
  type StepContext,
  type Warning,
  type WorkflowDef,
} from '../index';

/** Behaviour tests load the shipped JSON raw (no validation) so a bad JSON shows up as wrong behaviour. */
export const def = SHIPPED_WORKFLOW;
export const clone = (): WorkflowDef => structuredClone(def);
export const ctxOf = (
  marketingOptIn: boolean,
  optedOut = false,
  contactHasReceivedOptinWelcome = false
): StepContext => ({
  consent: { marketingOptIn, optedOut },
  contactHasReceivedOptinWelcome,
});
export const CONSENT = ctxOf(true);
export const NO_CONSENT = ctxOf(false);

/** Dubai wall-clock (UTC+4) on 2026-03-<day> → ISO UTC. */
export const dxb = (day: number, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 2, day, h! - 4, m!)).toISOString();
};
export const inb = (
  at: string,
  text = 'Hi',
  freeEntry = false
): JourneyEvent => ({ type: 'INBOUND_TEXT', text, at, freeEntry });
export const btn = (payload: string, at: string): JourneyEvent => ({
  type: 'BUTTON',
  payload,
  at,
});
export const media = (at: string): JourneyEvent => ({
  type: 'MEDIA',
  count: 1,
  at,
});
export const adv = (
  decision: Extract<JourneyEvent, { type: 'ADVISOR' }>['decision'],
  at: string,
  extra: { reasonCode?: string; validUntil?: string } = {}
): JourneyEvent => ({
  type: 'ADVISOR',
  decision,
  at,
  by: 'advisor-1',
  ...extra,
});

type Send = Extract<Action, { type: 'SEND' }>;

/** Host simulator: fires due timers (in fireAt order) before each event, like the host scheduler would. */
export class Sim {
  file: JourneyFile;
  log: { at: string; action: Action }[] = [];
  warnings: Warning[] = [];
  constructor(
    public wf: WorkflowDef = def,
    public ctx: StepContext = CONSENT,
    file?: JourneyFile
  ) {
    this.file =
      file ?? newFile({ id: 'f1', contactId: 'c1', workspaceId: 'w1' });
  }
  private apply(ev: JourneyEvent, now: string) {
    const r = step(this.wf, this.file, ev, now, this.ctx);
    if (r.error) throw new Error(`rejected: ${r.error.code}`);
    this.file = r.file;
    for (const action of r.actions) this.log.push({ at: now, action });
    this.warnings.push(...r.warnings);
    return r;
  }
  runUntil(until: string): this {
    for (;;) {
      const due = this.file.timers
        .filter((t) => Date.parse(t.fireAt) <= Date.parse(until))
        .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))[0];
      if (!due) return this;
      this.apply({ type: 'TIMER', kind: due.kind, at: due.fireAt }, due.fireAt);
    }
  }
  ev(...events: JourneyEvent[]): this {
    for (const e of events) {
      this.runUntil(e.at);
      this.apply(e, e.at);
    }
    return this;
  }
  sends(): (Send & { at: string })[] {
    return this.log
      .filter((x) => x.action.type === 'SEND')
      .map((x) => ({ ...(x.action as Send), at: x.at }));
  }
  tasks(): string[] {
    return this.log.flatMap((x) =>
      x.action.type === 'ADVISOR_TASK' ? [x.action.kind] : []
    );
  }
}

/** Inbound POS lead, day 1 (Dubai), through COMPARE → comparison → PROCEED into DOCS. */
export function posToDocs(
  sim: Sim,
  day = 1,
  t = ['10:14', '10:15', '10:16', '15:40', '16:02'],
  freeEntry = false
): Sim {
  return sim.ev(
    inb(dxb(day, t[0]!), 'Hi', freeEntry),
    btn('POS', dxb(day, t[1]!)),
    btn('COMPARE', dxb(day, t[2]!)),
    adv('COMPARISON_READY', dxb(day, t[3]!)),
    btn('PROCEED', dxb(day, t[4]!))
  );
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** In-memory `JourneyStore`: `commit` checks and writes in one synchronous section (atomic in-process). */
export class MemoryStore implements JourneyStore {
  files = new Map<string, JourneyFile>();
  processed = new Set<string>();
  outbox: OutboxItem[] = [];
  commits = 0;
  conflicts = 0;
  constructor(...files: JourneyFile[]) {
    for (const f of files) this.files.set(f.id, structuredClone(f));
  }
  async load(fileId: string): Promise<JourneyFile | null> {
    await tick();
    const f = this.files.get(fileId);
    return f ? structuredClone(f) : null;
  }
  async commit(
    expectedVersion: number,
    fileAfter: JourneyFile,
    eventId: string,
    actions: Action[]
  ): Promise<CommitResult> {
    await tick();
    // Synchronous section from here on: no await between the checks and the writes.
    const key = `${fileAfter.id}/${eventId}`;
    if (this.processed.has(key)) return 'duplicate';
    if (this.files.get(fileAfter.id)?.version !== expectedVersion) {
      this.conflicts++;
      return 'conflict';
    }
    this.files.set(fileAfter.id, {
      ...structuredClone(fileAfter),
      version: expectedVersion + 1,
    });
    this.processed.add(key);
    let seq = this.outbox.filter((i) => i.fileId === fileAfter.id).length;
    actions.forEach((action, n) =>
      this.outbox.push({
        id: `${key}/${n}`,
        fileId: fileAfter.id,
        seq: ++seq,
        action: structuredClone(action),
        status: 'pending',
      })
    );
    this.commits++;
    return 'ok';
  }
  async pendingOutbox(fileId: string): Promise<OutboxItem[]> {
    await tick();
    return this.outbox
      .filter((i) => i.fileId === fileId && i.status === 'pending')
      .map((i) => structuredClone(i));
  }
  async markDelivered(itemId: string): Promise<void> {
    await tick();
    const item = this.outbox.find((i) => i.id === itemId);
    if (item) item.status = 'delivered';
  }
  async markDropped(itemId: string, reason: string): Promise<void> {
    await tick();
    const item = this.outbox.find((i) => i.id === itemId);
    if (item) {
      item.status = 'dropped';
      item.dropReason = reason;
    }
  }
  async pendingOptOut(contactId: string): Promise<boolean | null> {
    await tick();
    const last = this.outbox
      .filter(
        (i) =>
          i.status === 'pending' &&
          i.action.type === 'SET_OPT_OUT' &&
          this.files.get(i.fileId)?.contactId === contactId
      )
      .at(-1);
    return last?.action.type === 'SET_OPT_OUT' ? last.action.optedOut : null;
  }
}

/** Records every successful `deliver` (no dedupe, so tests see double deliveries); `fail(item)` → throw. */
export class MemorySink implements ActionSink {
  delivered: OutboxItem[] = [];
  attempts = 0;
  fail: (item: OutboxItem) => boolean = () => false;
  async deliver(item: OutboxItem): Promise<void> {
    await tick();
    this.attempts++;
    if (this.fail(item)) throw new Error(`sink down (${item.id})`);
    this.delivered.push(item);
  }
  sends(): string[] {
    return this.delivered.flatMap((i) =>
      i.action.type === 'SEND' ? [i.action.template] : []
    );
  }
}

export const CONSENT_PORT = {
  async hasMarketingOptIn() {
    return true;
  },
  async isOptedOut() {
    return false;
  },
  async hasReceivedOptinWelcome() {
    return false;
  },
  async claimOptinWelcome() {
    return true;
  },
};
