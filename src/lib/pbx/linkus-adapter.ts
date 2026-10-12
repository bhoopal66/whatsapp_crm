// ============================================================
// The browser softphone (module 015): a SoftphoneAdapter over the
// Linkus SDK for Web (ys-webrtc-sdk-core), loaded by linkus-loader.ts
// and mounted by components/pbx/softphone-mount.tsx.
//
// Life cycle: fetch a login signature for the caller's own extension
// (POST /api/pbx/softphone/signature), init the SDK with it, subscribe
// to its events, then start the SIP registration (the SDK's guide: the
// listeners go on before start(), or events are missed). Registered =
// active: the call screens then answer, decline and control calls here
// instead of through the PBX API.
//
// A dropped connection is the SDK's to recover (it re-registers on its
// own). A login error or an expired login (RE_LOGIN) is ours: destroy,
// fetch a fresh signature and init again, never sooner than 30 s after
// the previous attempt, and not while a call is up. Errors a new login
// cannot fix are not retried; above all LOGGED_IN_ELSEWHERE, or two
// tabs would take the extension from each other forever.
//
// The SDK's callbacks are documented loosely (the incoming payload is
// shown both as `{callId, session}` and as `(callId, session)`), so
// every payload goes through the defensive readers in linkus-state.ts.
// ============================================================

import type { LinkusOperator, LinkusSdk } from './linkus-loader';
import {
  MIN_REINIT_MS,
  describeSdkCode,
  eventCallId,
  matchSession,
  retryDelayMs,
  sdkCode,
  sdkCodeRetryable,
  sdkFailed,
  sessionEventArgs,
  signatureFailure,
  viewOf,
  type SoftphoneState,
} from './linkus-state';
import type { SoftphoneAdapter, SoftphoneCallRef } from './softphone';

export interface SoftphoneSignature {
  username: string;
  sign: string;
  pbxUrl: string;
}

/** A failure with a verdict on whether a later attempt could succeed. */
export class SoftphoneError extends Error {
  constructor(
    message: string,
    readonly retry: boolean
  ) {
    super(message);
    this.name = 'SoftphoneError';
  }
}

/** POST /api/pbx/softphone/signature, as `SoftphoneSignature` or a SoftphoneError. */
export async function fetchSoftphoneSignature(
  fetchImpl: typeof fetch = fetch
): Promise<SoftphoneSignature> {
  let res: Response;
  try {
    res = await fetchImpl('/api/pbx/softphone/signature', { method: 'POST' });
  } catch (err) {
    throw new SoftphoneError(
      err instanceof Error ? err.message : String(err),
      true
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const f = signatureFailure(res.status, body);
    throw new SoftphoneError(f.message, f.retry);
  }
  const b = body as Partial<SoftphoneSignature> | null;
  if (!b?.username || !b.sign || !b.pbxUrl)
    throw new SoftphoneError('The softphone login was incomplete', true);
  return { username: b.username, sign: b.sign, pbxUrl: b.pbxUrl };
}

/** Plays a call's remote audio (an <audio> element in the browser). */
export interface SoftphoneMedia {
  play(callId: string, stream: unknown): void;
  stop(callId: string): void;
}

export interface LinkusAdapter extends SoftphoneAdapter {
  /** Sign in and register; resolves once the first attempt settles. */
  start(): Promise<void>;
  /** Unregister for good: sign-out, workspace switch, tab close. */
  destroy(): void;
  getState(): SoftphoneState;
}

interface Tracked {
  session: Record<string, unknown>;
  seenAt: number;
}

export function createLinkusAdapter(opts: {
  sdk: LinkusSdk;
  signature: () => Promise<SoftphoneSignature>;
  extension?: string | null;
  media?: SoftphoneMedia;
}): LinkusAdapter {
  const { sdk, signature, media } = opts;
  const listeners = new Set<() => void>();
  const sessions = new Map<string, Tracked>();
  const bound = new Map<string, string>(); // pbxCallId → SDK callId
  let state: SoftphoneState = {
    status: 'connecting',
    extension: opts.extension ?? null,
    error: null,
  };
  let op: LinkusOperator | null = null;
  let destroyed = false;
  let attempt = 0;
  let lastInitAt = -Infinity;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const notify = () => listeners.forEach((l) => l());
  const set = (next: Partial<SoftphoneState>) => {
    const merged = { ...state, ...next };
    if (
      merged.status === state.status &&
      merged.error === state.error &&
      merged.extension === state.extension
    )
      return;
    state = merged;
    notify();
  };

  const untrack = (callId: string) => {
    if (!sessions.delete(callId)) return;
    media?.stop(callId);
    for (const [k, v] of bound) if (v === callId) bound.delete(k);
    notify();
  };

  const teardown = () => {
    const old = op;
    op = null;
    for (const id of [...sessions.keys()]) untrack(id);
    bound.clear();
    try {
      old?.destroy();
    } catch {
      // Already torn down by the SDK.
    }
  };

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const ready = () => {
    attempt = 0;
    clearRetry();
    set({ status: 'ready', error: null });
  };

  const scheduleRetry = () => {
    if (destroyed || retryTimer) return;
    const wait = Math.max(
      retryDelayMs(attempt),
      lastInitAt + MIN_REINIT_MS - Date.now()
    );
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (sessions.size > 0) scheduleRetry();
      else void connect();
    }, wait);
  };

  const fail = (err: unknown) => {
    if (destroyed) return;
    const c = sdkCode(err);
    const retry = c
      ? sdkCodeRetryable(c.code)
      : err instanceof SoftphoneError
        ? err.retry
        : true;
    const error = c
      ? describeSdkCode(c.code, c.message)
      : err instanceof Error
        ? err.message
        : String(err);
    set({ status: 'error', error });
    if (retry) scheduleRetry();
    else teardown(); // stop the SDK re-registering against a lost cause
  };

  const track = (args: unknown[]) => {
    const ev = sessionEventArgs(args);
    if (!ev || sessions.has(ev.callId)) {
      if (ev) notify();
      return;
    }
    const { callId, session } = ev;
    sessions.set(callId, { session, seenAt: Date.now() });
    const on = session.on as LinkusOperator['pbx']['on'] | undefined;
    if (typeof on === 'function') {
      const sub = (name: string, fn: (...a: unknown[]) => void) =>
        on.call(session, name, fn);
      const playRemote = (payload?: unknown) => {
        const p = payload as { stream?: unknown } | undefined;
        const stream = p?.stream ?? session.remoteStream;
        if (stream) media?.play(callId, stream);
      };
      sub('streamAdded', playRemote);
      sub('confirmed', () => {
        playRemote();
        notify();
      });
      sub('statusChange', notify);
      sub('ended', () => untrack(callId));
      sub('failed', () => untrack(callId));
    }
    notify();
  };

  const wire = (o: LinkusOperator) => {
    const mine = generation;
    const live =
      (fn: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        if (!destroyed && mine === generation) fn(...a);
      };
    const { phone, pbx } = o;
    phone.on('registered', live(ready));
    phone.on(
      'isRegisteredChange',
      live((v) => {
        const on =
          typeof v === 'boolean'
            ? v
            : (v as { isRegistered?: unknown })?.isRegistered;
        if (on === true) ready();
        else if (on === false && state.status === 'ready')
          set({ status: 'reconnecting' });
      })
    );
    phone.on(
      'disconnected',
      live(() => {
        if (state.status === 'ready') set({ status: 'reconnecting' });
      })
    );
    phone.on(
      'registrationFailed',
      live((e) => {
        const c = sdkCode(e);
        set({
          status: 'error',
          error: c
            ? describeSdkCode(c.code, c.message)
            : 'The softphone could not register with the PBX',
        });
        scheduleRetry();
      })
    );
    for (const name of ['newRTCSession', 'incoming', 'startSession'])
      phone.on(
        name,
        live((...a) => track(a))
      );
    phone.on(
      'deleteSession',
      live((...a) => {
        const id = eventCallId(a);
        if (id) untrack(id);
      })
    );
    pbx.on(
      'runtimeError',
      live((e) => fail(sdkCode(e) ?? new Error('The PBX reported an error')))
    );
  };

  async function connect(): Promise<void> {
    if (destroyed) return;
    generation += 1;
    const mine = generation;
    lastInitAt = Date.now();
    teardown();
    set({
      status: state.status === 'connecting' ? 'connecting' : 'reconnecting',
    });
    try {
      const sig = await signature();
      if (destroyed || mine !== generation) return;
      const o = await sdk.init({
        username: sig.username,
        secret: sig.sign,
        pbxURL: sig.pbxUrl,
      });
      if (destroyed || mine !== generation) {
        o.destroy();
        return;
      }
      op = o;
      wire(o);
      o.phone.start();
    } catch (err) {
      if (mine === generation) fail(err);
    }
  }

  const views = () =>
    [...sessions].map(([id, t]) => viewOf(id, t.session.status, t.seenAt));

  const resolve = (call: SoftphoneCallRef, purpose: 'answer' | 'live') => {
    if (!op || state.status !== 'ready')
      throw new Error('The softphone is not connected');
    const id = matchSession(
      views(),
      call,
      purpose,
      bound.get(call.pbxCallId) ?? null
    );
    if (!id) throw new Error('This call is not ringing in the softphone');
    bound.set(call.pbxCallId, id);
    return { phone: op.phone, id };
  };

  const check = (ok: unknown, what: string) => {
    if (ok === false) throw new Error(`The softphone could not ${what}`);
    const c = sdkCode(ok);
    if (c && sdkFailed(ok)) throw new Error(describeSdkCode(c.code, c.message));
  };

  return {
    isActive: () => !destroyed && op !== null && state.status === 'ready',
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getState: () => state,
    start: () => connect(),
    destroy() {
      if (destroyed) return;
      generation += 1;
      clearRetry();
      teardown();
      state = { ...state, status: 'off', error: null };
      notify();
      destroyed = true;
      listeners.clear();
    },
    async answer(call) {
      const { phone, id } = resolve(call, 'answer');
      check(await phone.answer(id), 'answer');
    },
    async decline(call) {
      const { phone, id } = resolve(call, 'answer');
      check(phone.reject(id), 'decline');
    },
    async hangup(call) {
      const { phone, id } = resolve(call, 'live');
      check(phone.hangup(id), 'hang up');
    },
    async mute(call, muted) {
      const { phone, id } = resolve(call, 'live');
      check(muted ? phone.mute(id) : phone.unmute(id), 'mute');
    },
    async hold(call, held) {
      const { phone, id } = resolve(call, 'live');
      check(held ? phone.hold(id) : phone.unhold(id), 'hold');
    },
    async dtmf(call, digits) {
      if (!/^[0-9*#]+$/.test(digits))
        throw new Error('Keypad tones are 0-9, * and #');
      const { phone, id } = resolve(call, 'live');
      for (const d of digits) check(phone.dtmf(id, d), 'send the tone');
    },
    async call(number) {
      const n = number.trim();
      if (!n) throw new Error('No number to call');
      if (!op || state.status !== 'ready')
        throw new Error('The softphone is not connected');
      check(await op.phone.call(n), 'place the call');
    },
  };
}
