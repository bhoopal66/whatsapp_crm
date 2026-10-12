/** Thin orchestrator: load → step → commit (file + processed event + outbox, atomically) → drain the outbox. */
import { step } from './engine';
import type {
  ActionSink,
  ConsentPort,
  JourneyStore,
  OutboxItem,
  RunnerEvent,
} from './ports';
import type { WorkflowDef } from './schema';
import type { JourneyEvent, StepResult } from './types';
import { toMs } from './time';

/** Conflict retries after the first attempt before `handle` gives up. */
export const MAX_CONFLICT_RETRIES = 3;

/** The file kept changing under `handle` (version conflict on every attempt). Nothing was committed. */
export class JourneyConflictError extends Error {
  constructor(
    readonly fileId: string,
    readonly eventId: string,
    readonly attempts: number
  ) {
    super(
      `journey file ${fileId}: version conflict on ${attempts} attempts (event ${eventId})`
    );
    this.name = 'JourneyConflictError';
  }
}

/**
 * `delivered` / `dropped` this drain (dropped only when > 0); `pending` left — ≥1 when a delivery failed (`error` holds
 * it) or a SEND is not due yet (`deferredUntil` = its notBefore; drain again then).
 */
export interface DrainResult {
  delivered: number;
  pending: number;
  dropped?: number;
  deferredUntil?: string;
  error?: unknown;
}

const OPTIN_WELCOME = 'taamul_optin_welcome';

/** Delivery-time consent re-check (§5/§7): why this SEND must not go out now, or null. */
async function blockedSend(
  ports: { store: JourneyStore; consent: ConsentPort },
  contactId: string,
  item: OutboxItem
): Promise<string | null> {
  const a = item.action;
  if (a.type !== 'SEND') return null;
  if (a.category === 'MARKETING') {
    const optedOut =
      (await ports.store.pendingOptOut(contactId)) ??
      (await ports.consent.isOptedOut(contactId));
    if (optedOut) return 'OPTED_OUT';
    if (!(await ports.consent.hasMarketingOptIn(contactId)))
      return 'NO_CONSENT';
  }
  if (
    a.template === OPTIN_WELCOME &&
    !(await ports.consent.claimOptinWelcome(contactId, item.id))
  )
    return 'CAP_REACHED';
  return null;
}

/**
 * Delivers the file's pending outbox items in `seq` order, marking each delivered; stops at the first failure
 * (that item and every later one stay pending, so actions never overtake each other). A SEND whose `notBefore` is
 * after `now` (and its LOG_COST) is skipped and stays pending — later items still go, so a night-time STOP is
 * confirmed and recorded at once; `deferredUntil` is the earliest such notBefore. Every SEND is re-checked against consent first: a MARKETING send to a contact now opted out
 * (register or a still-pending SET_OPT_OUT on any file) or without marketing opt-in, or an opt-in welcome whose
 * per-contact claim fails, is marked `dropped` (with its LOG_COST) and never delivered. Safe to call from a host retry
 * loop; concurrent drains may redeliver an item, which the sink dedupes on `item.id`.
 */
export async function drain(
  ports: { store: JourneyStore; sink: ActionSink; consent: ConsentPort },
  fileId: string,
  now: string = new Date().toISOString()
): Promise<DrainResult> {
  const items = (await ports.store.pendingOutbox(fileId)).sort(
    (a, b) => a.seq - b.seq
  );
  let delivered = 0,
    dropped = 0,
    contactId: string | undefined,
    droppedSend: string | null = null;
  let deferredUntil: string | undefined,
    deferredSend: string | null = null;
  const result = (
    r: Omit<DrainResult, 'delivered' | 'dropped' | 'pending'>
  ): DrainResult => ({
    delivered,
    pending: items.length - delivered - dropped,
    ...(dropped ? { dropped } : {}),
    ...(deferredUntil ? { deferredUntil } : {}),
    ...r,
  });
  for (const item of items) {
    const a = item.action;
    // A send held for quiet hours (and its LOG_COST) waits, but must not hold back later items: an opt-out
    // confirmation and SET_OPT_OUT have to go out immediately, even at night.
    if (a.type === 'SEND' && a.notBefore && toMs(a.notBefore) > toMs(now)) {
      if (!deferredUntil || toMs(a.notBefore) < toMs(deferredUntil))
        deferredUntil = a.notBefore;
      deferredSend = a.template;
      continue;
    }
    if (a.type === 'LOG_COST' && a.template === deferredSend) {
      deferredSend = null;
      continue;
    }
    deferredSend = null;
    let why: string | null = null;
    try {
      if (a.type === 'SEND') {
        contactId ??= (await ports.store.load(fileId))?.contactId;
        why = contactId ? await blockedSend(ports, contactId, item) : 'NO_FILE';
      } else if (a.type === 'LOG_COST' && a.template === droppedSend)
        why = 'SEND_DROPPED';
      droppedSend = why && a.type === 'SEND' ? a.template : null;
      if (why) await ports.store.markDropped(item.id, why);
      else {
        await ports.sink.deliver(item);
        await ports.store.markDelivered(item.id);
      }
    } catch (error) {
      return result({ error });
    }
    if (why) dropped++;
    else delivered++;
  }
  return result({});
}

export type HandleResult =
  | { status: 'duplicate' }
  | { status: 'not_found' }
  | { status: 'rejected'; error: NonNullable<StepResult['error']> }
  | { status: 'ok'; result: StepResult; drain: DrainResult };

export interface RunnerDeps {
  def: WorkflowDef;
  store: JourneyStore;
  sink: ActionSink;
  consent: ConsentPort;
  /** Host-chosen template variant for a file (e.g. POS "intro" | "switch"). */
  variantOf?: (fileId: string) => string | undefined;
}

export function createRunner(deps: RunnerDeps) {
  /** Serialises this runner's drains per file so its own drains never deliver an item twice. */
  const draining = new Map<string, Promise<DrainResult>>();
  function drainFile(fileId: string, now?: string): Promise<DrainResult> {
    const run = (draining.get(fileId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => drain(deps, fileId, now));
    draining.set(fileId, run);
    void run
      .finally(() => {
        if (draining.get(fileId) === run) draining.delete(fileId);
      })
      .catch(() => undefined);
    return run;
  }

  return {
    drain: drainFile,
    async handle(
      event: RunnerEvent,
      now: string = event.at
    ): Promise<HandleResult> {
      const { id, fileId, ...rest } = event;
      for (let attempt = 1; attempt <= 1 + MAX_CONFLICT_RETRIES; attempt++) {
        const file = await deps.store.load(fileId);
        if (!file) return { status: 'not_found' };
        const [marketingOptIn, optedOut, received] = await Promise.all([
          deps.consent.hasMarketingOptIn(file.contactId),
          deps.consent.isOptedOut(file.contactId),
          deps.consent.hasReceivedOptinWelcome(file.contactId),
        ]);
        const variant = deps.variantOf?.(fileId);
        const result = step(deps.def, file, rest as JourneyEvent, now, {
          consent: { marketingOptIn, optedOut },
          contactHasReceivedOptinWelcome: received,
          ...(variant ? { variant } : {}),
        });
        if (result.error) return { status: 'rejected', error: result.error };
        const committed = await deps.store.commit(
          file.version,
          result.file,
          id,
          result.actions
        );
        // A redelivered event still drains: recovers a crash between commit and drain.
        if (committed === 'duplicate') {
          await drainFile(fileId, now);
          return { status: 'duplicate' };
        }
        if (committed === 'ok')
          return { status: 'ok', result, drain: await drainFile(fileId, now) };
      }
      throw new JourneyConflictError(fileId, id, 1 + MAX_CONFLICT_RETRIES);
    },
  };
}
