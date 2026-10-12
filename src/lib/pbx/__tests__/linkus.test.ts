import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkusAdapter, SoftphoneError } from '../linkus-adapter';
import { loadLinkusSdk, shouldLoadSoftphone } from '../linkus-loader';
import {
  matchSession,
  numbersMatch,
  sessionEventArgs,
  signatureFailure,
  viewOf,
} from '../linkus-state';

const ON = { softphoneEnabled: true, softphoneAvailable: true };
const URL_ESM = 'https://cdn.example.com/ys-webrtc/index.js';
const fakeSdk = { init: vi.fn() };

describe('linkus-state', () => {
  it('matches numbers across +971 / 00971 / 0 forms, extensions exactly', () => {
    expect(numbersMatch('+971501234567', '0501234567')).toBe(true);
    expect(numbersMatch('00971501234567', '971501234567')).toBe(true);
    expect(numbersMatch('1012', '1012')).toBe(true);
    expect(numbersMatch('1012', '21012')).toBe(false);
    expect(numbersMatch('+971501234567', '+971501234568')).toBe(false);
    expect(numbersMatch(null, '1012')).toBe(false);
  });

  const v = (id: string, number: string | null, extra: object = {}) =>
    viewOf(
      id,
      { number, communicationType: 'inbound', callStatus: 'ringing', ...extra },
      Number(id.slice(1))
    );
  const ref = (remoteNumber: string | null) => ({
    pbxCallId: 'p1',
    remoteNumber,
  });

  it('answers the ringing inbound session with the same number', () => {
    const s = [v('s1', '0501111111'), v('s2', '0502222222')];
    expect(matchSession(s, ref('+971502222222'), 'answer')).toBe('s2');
    expect(matchSession(s, ref('+971509999999'), 'answer')).toBeNull();
  });

  it('falls back to the only candidate, never guesses between two', () => {
    expect(matchSession([v('s1', '777')], ref(null), 'answer')).toBe('s1');
    const two = [v('s1', '777'), v('s2', '888')];
    expect(matchSession(two, ref(null), 'answer')).toBeNull();
    const talking = [v('s1', '777', { callStatus: 'talking' })];
    expect(matchSession(talking, ref(null), 'answer')).toBeNull();
    expect(matchSession(talking, ref(null), 'live')).toBe('s1');
  });

  it('keeps a bound session and prefers talking for live actions', () => {
    const s = [
      v('s1', '0501111111', { callStatus: 'talking' }),
      v('s9', '0501111111'),
    ];
    expect(matchSession(s, ref('0501111111'), 'live')).toBe('s1');
    expect(matchSession(s, ref('0501111111'), 'live', 's9')).toBe('s9');
  });

  it('reads both incoming payload shapes', () => {
    const session = { status: { callId: 'c1' } };
    expect(sessionEventArgs([{ callId: 'c1', session }])?.callId).toBe('c1');
    expect(sessionEventArgs(['c2', session])?.callId).toBe('c2');
    expect(sessionEventArgs([{ session }])?.callId).toBe('c1');
    expect(sessionEventArgs([42])).toBeNull();
  });

  it('retries a signature only on 5xx / 429 / network', () => {
    expect(signatureFailure(409, { error: 'off' })).toEqual({
      message: 'off',
      retry: false,
    });
    expect(signatureFailure(502, null).retry).toBe(true);
  });
});

describe('linkus-loader', () => {
  const g = () => ({}) as Record<string, unknown>;

  it('loads nothing without a URL, for a person without the softphone, or without SDK credentials', async () => {
    const importer = vi.fn(async () => fakeSdk);
    const deps = { importer, global: g() };
    expect(await loadLinkusSdk(ON, null, deps)).toBeNull();
    expect(
      await loadLinkusSdk({ ...ON, softphoneEnabled: false }, URL_ESM, deps)
    ).toBeNull();
    expect(
      await loadLinkusSdk({ ...ON, softphoneAvailable: false }, URL_ESM, deps)
    ).toBeNull();
    expect(await loadLinkusSdk(null, URL_ESM, deps)).toBeNull();
    expect(importer).not.toHaveBeenCalled();
    expect(shouldLoadSoftphone(ON, URL_ESM)).toBe(true);
  });

  it('loads nothing on the server', async () => {
    expect(await loadLinkusSdk(ON, URL_ESM)).toBeNull();
  });

  it('uses an ES module build directly', async () => {
    const importer = vi.fn(async () => ({ init: fakeSdk.init }));
    const injectScript = vi.fn();
    const sdk = await loadLinkusSdk(ON, URL_ESM, {
      importer,
      injectScript,
      global: g(),
    });
    expect(sdk?.init).toBe(fakeSdk.init);
    expect(injectScript).not.toHaveBeenCalled();
  });

  it('falls back to a script tag and the YSWebRTC global', async () => {
    const global = g();
    const importer = vi.fn(async () => {
      throw new TypeError('CORS');
    });
    const injectScript = vi.fn(async () => {
      global.YSWebRTC = fakeSdk;
    });
    const sdk = await loadLinkusSdk(ON, URL_ESM, {
      importer,
      injectScript,
      global,
    });
    expect(sdk).toBe(fakeSdk);
    // A UMD build by name skips the module attempt.
    importer.mockClear();
    await loadLinkusSdk(ON, 'https://x.test/ys-webrtc.umd.js', {
      importer,
      injectScript,
      global,
    });
    expect(importer).not.toHaveBeenCalled();
  });

  it('fails with a clear error on timeout or the wrong bundle', async () => {
    const never = () => new Promise<void>(() => {});
    await expect(
      loadLinkusSdk(ON, 'https://x.test/a.umd.js', {
        injectScript: never,
        global: g(),
        timeoutMs: 10,
      })
    ).rejects.toThrow(/could not be loaded.*timed out/);
    await expect(
      loadLinkusSdk(ON, 'https://x.test/a.umd.js', {
        injectScript: async () => {},
        global: g(),
      })
    ).rejects.toThrow(/not the Linkus SDK/);
  });
});

function fakeOperator() {
  const phone = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    call: vi.fn(async () => ({ code: 200, message: 'ok' })),
    answer: vi.fn(async () => ({ code: 200, message: 'ok' })),
    reject: vi.fn(() => true),
    hangup: vi.fn(() => true),
    mute: vi.fn(() => true),
    unmute: vi.fn(() => true),
    hold: vi.fn(() => true),
    unhold: vi.fn(() => true),
    dtmf: vi.fn(() => true),
  });
  return { phone, pbx: new EventEmitter(), destroy: vi.fn() };
}

const SIG = { username: '1012', sign: 's', pbxUrl: 'https://pbx.test' };

async function started() {
  const ops: ReturnType<typeof fakeOperator>[] = [];
  const sdk = {
    init: vi.fn(async () => {
      const o = fakeOperator();
      ops.push(o);
      return o;
    }),
  };
  const signature = vi.fn(async () => SIG);
  const media = { play: vi.fn(), stop: vi.fn() };
  const a = createLinkusAdapter({ sdk, signature, media, extension: '1012' });
  const changed = vi.fn();
  a.subscribe(changed);
  await a.start();
  return { a, sdk, ops, signature, media, changed };
}

describe('linkus-adapter', () => {
  afterEach(() => vi.useRealTimers());

  it('signs in, listens before start(), and is active once registered', async () => {
    const { a, sdk, ops, changed } = await started();
    expect(sdk.init).toHaveBeenCalledWith({
      username: '1012',
      secret: 's',
      pbxURL: 'https://pbx.test',
    });
    const { phone } = ops[0];
    expect(phone.listenerCount('incoming')).toBe(1);
    expect(phone.start).toHaveBeenCalledOnce();
    expect(a.isActive()).toBe(false);
    phone.emit('registered');
    expect(a.isActive()).toBe(true);
    expect(a.getState()).toMatchObject({ status: 'ready', extension: '1012' });
    expect(changed).toHaveBeenCalled();
  });

  it('maps call-screen actions onto the matching SDK session', async () => {
    const { a, ops, media } = await started();
    const { phone } = ops[0];
    phone.emit('registered');
    const session = Object.assign(new EventEmitter(), {
      status: {
        callId: 'sip-1',
        number: '0501234567',
        communicationType: 'inbound',
        callStatus: 'ringing',
      },
    });
    phone.emit('incoming', { callId: 'sip-1', session });
    const ref = { pbxCallId: 'pbx-9', remoteNumber: '+971501234567' };
    await a.answer(ref);
    expect(phone.answer).toHaveBeenCalledWith('sip-1');
    session.status.callStatus = 'talking';
    session.emit('streamAdded', { callId: 'sip-1', stream: 'remote' });
    expect(media.play).toHaveBeenCalledWith('sip-1', 'remote');
    await a.mute(ref, true);
    await a.hold(ref, false);
    await a.dtmf(ref, '1#');
    await a.hangup(ref);
    expect(phone.mute).toHaveBeenCalledWith('sip-1');
    expect(phone.unhold).toHaveBeenCalledWith('sip-1');
    expect(phone.dtmf.mock.calls).toEqual([
      ['sip-1', '1'],
      ['sip-1', '#'],
    ]);
    expect(phone.hangup).toHaveBeenCalledWith('sip-1');
    phone.emit('deleteSession', { callId: 'sip-1', cause: 'bye' });
    expect(media.stop).toHaveBeenCalledWith('sip-1');
    await expect(a.hangup(ref)).rejects.toThrow(/not ringing/);
  });

  it('turns an SDK failure code into an error', async () => {
    const { a, ops } = await started();
    ops[0].phone.emit('registered');
    ops[0].phone.call.mockResolvedValueOnce({ code: -202, message: 'x' });
    await expect(a.call('0501234567')).rejects.toThrow(/Microphone/);
  });

  it('re-signs in after RE_LOGIN, not sooner than 30 s', async () => {
    vi.useFakeTimers();
    const { a, sdk, ops, signature } = await started();
    ops[0].phone.emit('registered');
    ops[0].pbx.emit('runtimeError', { code: -109, msg: 'RE_LOGIN' });
    expect(a.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(signature).toHaveBeenCalledTimes(2);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(ops[0].destroy).toHaveBeenCalled();
  });

  it('does not fight another tab, or retry a refused signature', async () => {
    vi.useFakeTimers();
    const { a, sdk, ops } = await started();
    ops[0].pbx.emit('runtimeError', { code: -107, msg: 'elsewhere' });
    expect(a.getState().error).toMatch(/elsewhere/);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sdk.init).toHaveBeenCalledTimes(1);

    const b = createLinkusAdapter({
      sdk,
      signature: async () => {
        throw new SoftphoneError('softphone off', false);
      },
    });
    await b.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(b.getState()).toMatchObject({
      status: 'error',
      error: 'softphone off',
    });
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('destroy() tears the SDK down and stops retrying', async () => {
    vi.useFakeTimers();
    const { a, sdk, ops } = await started();
    ops[0].phone.emit('registrationFailed', { code: -101, msg: 'x' });
    a.destroy();
    expect(ops[0].destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(a.isActive()).toBe(false);
  });
});
