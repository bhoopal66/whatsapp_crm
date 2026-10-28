// ============================================================
// Settings → Numbers: the "Connect with OpenWA" dialog's state machine.
//
// The dialog creates a session (POST /api/whatsapp/config/openwa), then
// polls `[configId]/status` until the phone has scanned the QR. Every
// decision lives here, as a pure reducer, because the test environment
// has no DOM: the component only feeds it the POST result and each poll
// answer, and reads back what to show and whether to poll again.
// ============================================================

/** Poll cadence. OpenWA rotates its QR roughly every 20 s. */
export const OPENWA_POLL_INTERVAL_MS = 3_000;

/**
 * Give up after this long without `ready`. A session left waiting keeps
 * an engine running on the gateway, so the dialog stops and offers a
 * retry (which starts a fresh session) instead of polling forever.
 */
export const OPENWA_GIVE_UP_MS = 5 * 60_000;

/** OpenWA's own words for a session, as the status route relays them. */
export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

const KEEP_POLLING: ReadonlySet<string> = new Set([
  'created',
  'initializing',
  'qr_ready',
  'authenticating',
]);

/** Still on the way to linked: poll again. */
export function isKeepPollingStatus(status: string): boolean {
  return KEEP_POLLING.has(status);
}

/** The phone is linked and the server has marked the number connected. */
export function isLinkedStatus(status: string): boolean {
  return status === 'ready';
}

/**
 * Will not become linked without the admin starting over. `disconnected`
 * belongs here too: during linking it means the phone refused or dropped
 * the pairing, and a session in that state shows no new QR.
 */
export function isNotLinkedStatus(status: string): boolean {
  return (
    status === 'failed' ||
    status === 'action_required' ||
    status === 'disconnected'
  );
}

export type ConnectPhase =
  | 'idle'
  | 'creating'
  | 'waitingForQr'
  | 'showingQr'
  | 'linking'
  | 'connected'
  | 'failed'
  | 'cancelled';

export type ConnectFailure =
  /** The server has no OpenWA admin key (`OPENWA_API_KEY`). */
  | 'notConfigured'
  /** The POST failed; `error` carries the server's text. */
  | 'createFailed'
  /** OpenWA answered failed / action_required / disconnected. */
  | 'notLinked'
  /** No `ready` within OPENWA_GIVE_UP_MS. */
  | 'timedOut';

export interface ConnectState {
  phase: ConnectPhase;
  configId: string | null;
  qrCode: string | null;
  phone: string | null;
  /** When the session was created, for the give-up clock. */
  startedAt: number | null;
  failure: ConnectFailure | null;
  error: string | null;
  /** The last status OpenWA reported, for the label under the QR. */
  lastStatus: string | null;
}

export type ConnectEvent =
  | { type: 'start' }
  | { type: 'created'; configId: string; at: number }
  | { type: 'createFailed'; notConfigured: boolean; error?: string }
  | {
      type: 'polled';
      status: string;
      qrCode?: string | null;
      phone?: string | null;
      at: number;
    }
  /** A poll that did not answer. Transient: only the clock can fail it. */
  | { type: 'pollFailed'; at: number }
  | { type: 'cancel' }
  /** The give-up check found the phone linked after all. */
  | { type: 'lateLinked'; phone?: string | null }
  | { type: 'reset' };

export const initialConnectState: ConnectState = {
  phase: 'idle',
  configId: null,
  qrCode: null,
  phone: null,
  startedAt: null,
  failure: null,
  error: null,
  lastStatus: null,
};

/** True while a poll answer is still meaningful. */
export function isPolling(state: ConnectState): boolean {
  return (
    state.phase === 'waitingForQr' ||
    state.phase === 'showingQr' ||
    state.phase === 'linking'
  );
}

function timedOut(state: ConnectState, at: number): boolean {
  return state.startedAt !== null && at - state.startedAt >= OPENWA_GIVE_UP_MS;
}

export function connectReducer(
  state: ConnectState,
  event: ConnectEvent
): ConnectState {
  switch (event.type) {
    case 'reset':
      return initialConnectState;
    case 'start':
      // Only from rest: a double-clicked Connect must not open two sessions.
      if (
        state.phase !== 'idle' &&
        state.phase !== 'failed' &&
        state.phase !== 'cancelled'
      ) {
        return state;
      }
      return { ...initialConnectState, phase: 'creating' };
    case 'created':
      if (state.phase !== 'creating') return state;
      return {
        ...state,
        phase: 'waitingForQr',
        configId: event.configId,
        startedAt: event.at,
      };
    case 'createFailed':
      if (state.phase !== 'creating') return state;
      return {
        ...state,
        phase: 'failed',
        failure: event.notConfigured ? 'notConfigured' : 'createFailed',
        error: event.error ?? null,
      };
    case 'pollFailed':
      if (!isPolling(state)) return state;
      return timedOut(state, event.at)
        ? { ...state, phase: 'failed', failure: 'timedOut' }
        : state;
    case 'polled': {
      // A late answer after cancel, failure or success changes nothing.
      if (!isPolling(state)) return state;
      const next = { ...state, lastStatus: event.status };
      const keepPolling = isKeepPollingStatus(event.status);
      if (!keepPolling && isLinkedStatus(event.status)) {
        return { ...next, phase: 'connected', phone: event.phone ?? null };
      }
      if (!keepPolling && isNotLinkedStatus(event.status)) {
        return { ...next, phase: 'failed', failure: 'notLinked' };
      }
      if (timedOut(state, event.at)) {
        return { ...next, phase: 'failed', failure: 'timedOut' };
      }
      if (event.status === 'qr_ready') {
        // The route omits qrCode when fetching it failed; keep the last
        // one on screen rather than flash an empty box between polls.
        return {
          ...next,
          phase: 'showingQr',
          qrCode: event.qrCode ?? state.qrCode,
        };
      }
      if (event.status === 'authenticating') {
        return { ...next, phase: 'linking', qrCode: null };
      }
      // created / initializing, or a word this build does not know:
      // keep waiting, and let the clock decide.
      return { ...next, phase: state.qrCode ? 'showingQr' : 'waitingForQr' };
    }
    case 'cancel':
      if (state.phase === 'connected') return state;
      return { ...state, phase: 'cancelled' };
    case 'lateLinked':
      if (state.phase !== 'failed' || state.failure !== 'timedOut') {
        return state;
      }
      return {
        ...state,
        phase: 'connected',
        failure: null,
        lastStatus: 'ready',
        phone: event.phone ?? null,
      };
  }
}

/**
 * Whether closing the dialog now must DELETE the half-made number: a
 * session exists and never linked. Leaving it would keep an engine and a
 * scoped key alive on the gateway, and a "Not connected" row in the list.
 */
export function needsCleanup(state: ConnectState): boolean {
  return state.configId !== null && state.phase !== 'connected';
}

/**
 * What closing (or retrying) must do with the half-made number.
 *
 * - `none`: nothing on the gateway, or it linked.
 * - `remove`: OpenWA itself said it will not link (failed,
 *   action_required, disconnected): DELETE straight away.
 * - `checkFirst`: the dialog does not know. It gave up on the clock, or
 *   it is closed mid-poll, and a phone can link at any moment in
 *   between: a scan seconds after the 5-minute mark used to be deleted
 *   on close, unlinking a number that had just connected.
 */
export type CleanupPlan = 'none' | 'remove' | 'checkFirst';

export function cleanupPlan(state: ConnectState): CleanupPlan {
  if (!needsCleanup(state)) return 'none';
  if (isPolling(state)) return 'checkFirst';
  if (state.phase === 'failed' && state.failure === 'timedOut') {
    return 'checkFirst';
  }
  return 'remove';
}

export type CleanupOutcome =
  /** The phone is linked: the number stays, as connected. */
  | { kind: 'kept'; phone: string | null }
  | { kind: 'removed' }
  | { kind: 'removeFailed'; error: string };

/**
 * Carry out a cleanup plan. `checkStatus` asks the status route once
 * (null when it did not answer); `remove` DELETEs the number and
 * returns an error text or null. Only `ready` keeps it: anything else,
 * an unanswered check included, removes it, because an unlinked session
 * keeps a browser running on the gateway.
 */
export async function settleUnfinishedSession(
  plan: CleanupPlan,
  deps: {
    checkStatus: () => Promise<{
      status: string;
      phone?: string | null;
    } | null>;
    remove: () => Promise<string | null>;
  }
): Promise<CleanupOutcome | null> {
  if (plan === 'none') return null;
  if (plan === 'checkFirst') {
    const answer = await deps.checkStatus().catch(() => null);
    if (answer && isLinkedStatus(answer.status)) {
      return { kind: 'kept', phone: answer.phone ?? null };
    }
  }
  const error = await deps.remove();
  return error ? { kind: 'removeFailed', error } : { kind: 'removed' };
}

export type OpenWAStatusLabelKey =
  | 'starting'
  | 'scan'
  | 'linking'
  | 'ready'
  | 'disconnected'
  | 'actionRequired'
  | 'failed';

/** Status → key under `Settings.numbers.openwa.status`. */
export function openwaStatusLabelKey(status: string): OpenWAStatusLabelKey {
  switch (status) {
    case 'qr_ready':
      return 'scan';
    case 'authenticating':
      return 'linking';
    case 'ready':
      return 'ready';
    case 'disconnected':
      return 'disconnected';
    case 'action_required':
      return 'actionRequired';
    case 'failed':
      return 'failed';
    default:
      return 'starting';
  }
}
