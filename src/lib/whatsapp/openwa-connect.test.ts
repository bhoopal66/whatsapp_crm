import { describe, expect, it } from 'vitest';

import {
  OPENWA_GIVE_UP_MS,
  OPENWA_POLL_INTERVAL_MS,
  connectReducer,
  initialConnectState,
  isKeepPollingStatus,
  isLinkedStatus,
  isNotLinkedStatus,
  isPolling,
  needsCleanup,
  openwaStatusLabelKey,
  type ConnectEvent,
  type ConnectState,
} from './openwa-connect';

function run(...events: ConnectEvent[]): ConnectState {
  return events.reduce(connectReducer, initialConnectState);
}

const T0 = 1_000_000;
const created: ConnectEvent[] = [
  { type: 'start' },
  { type: 'created', configId: 'cfg-1', at: T0 },
];

describe('status classes', () => {
  it('keeps polling only on the way to linked', () => {
    for (const s of ['created', 'initializing', 'qr_ready', 'authenticating'])
      expect(isKeepPollingStatus(s)).toBe(true);
    for (const s of ['ready', 'failed', 'action_required', 'disconnected'])
      expect(isKeepPollingStatus(s)).toBe(false);
  });

  it('treats only ready as linked', () => {
    expect(isLinkedStatus('ready')).toBe(true);
    expect(isLinkedStatus('authenticating')).toBe(false);
  });

  it('treats failed, action_required and disconnected as not linked', () => {
    for (const s of ['failed', 'action_required', 'disconnected'])
      expect(isNotLinkedStatus(s)).toBe(true);
    expect(isNotLinkedStatus('qr_ready')).toBe(false);
  });

  it('polls every 3 s and gives up after 5 minutes', () => {
    expect(OPENWA_POLL_INTERVAL_MS).toBe(3_000);
    expect(OPENWA_GIVE_UP_MS).toBe(300_000);
  });
});

describe('connectReducer', () => {
  it('walks idle → creating → waiting → QR → linking → connected', () => {
    let s = connectReducer(initialConnectState, { type: 'start' });
    expect(s.phase).toBe('creating');
    s = connectReducer(s, { type: 'created', configId: 'cfg-1', at: T0 });
    expect(s).toMatchObject({ phase: 'waitingForQr', configId: 'cfg-1' });
    expect(isPolling(s)).toBe(true);
    s = connectReducer(s, { type: 'polled', status: 'initializing', at: T0 });
    expect(s.phase).toBe('waitingForQr');
    s = connectReducer(s, {
      type: 'polled',
      status: 'qr_ready',
      qrCode: 'data:image/png;base64,AAA',
      at: T0 + 3_000,
    });
    expect(s).toMatchObject({
      phase: 'showingQr',
      qrCode: 'data:image/png;base64,AAA',
    });
    s = connectReducer(s, {
      type: 'polled',
      status: 'authenticating',
      at: T0 + 6_000,
    });
    expect(s).toMatchObject({ phase: 'linking', qrCode: null });
    s = connectReducer(s, {
      type: 'polled',
      status: 'ready',
      phone: '971501234567',
      at: T0 + 9_000,
    });
    expect(s).toMatchObject({ phase: 'connected', phone: '971501234567' });
    expect(isPolling(s)).toBe(false);
    expect(needsCleanup(s)).toBe(false);
  });

  it('keeps the last QR when a poll omits it', () => {
    const s = run(
      ...created,
      { type: 'polled', status: 'qr_ready', qrCode: 'qr-1', at: T0 },
      { type: 'polled', status: 'qr_ready', at: T0 + 3_000 }
    );
    expect(s.qrCode).toBe('qr-1');
  });

  it('fails as not linked on failed, action_required or disconnected', () => {
    for (const status of ['failed', 'action_required', 'disconnected']) {
      const s = run(
        ...created,
        { type: 'polled', status: 'qr_ready', qrCode: 'q', at: T0 },
        { type: 'polled', status, at: T0 + 3_000 }
      );
      expect(s).toMatchObject({ phase: 'failed', failure: 'notLinked' });
      expect(needsCleanup(s)).toBe(true);
    }
  });

  it('gives up after 5 minutes without ready, then allows a retry', () => {
    const still = run(...created, {
      type: 'polled',
      status: 'qr_ready',
      qrCode: 'q',
      at: T0 + OPENWA_GIVE_UP_MS - 1,
    });
    expect(still.phase).toBe('showingQr');
    const gone = connectReducer(still, {
      type: 'polled',
      status: 'qr_ready',
      qrCode: 'q',
      at: T0 + OPENWA_GIVE_UP_MS,
    });
    expect(gone).toMatchObject({ phase: 'failed', failure: 'timedOut' });
    const retry = connectReducer(gone, { type: 'start' });
    expect(retry).toMatchObject({ phase: 'creating', configId: null });
  });

  it('a ready answer at the deadline still connects', () => {
    const s = run(...created, {
      type: 'polled',
      status: 'ready',
      at: T0 + OPENWA_GIVE_UP_MS + 10,
    });
    expect(s.phase).toBe('connected');
  });

  it('treats a failed poll as transient until the clock runs out', () => {
    const s = run(...created, { type: 'pollFailed', at: T0 + 3_000 });
    expect(s.phase).toBe('waitingForQr');
    const t = connectReducer(s, {
      type: 'pollFailed',
      at: T0 + OPENWA_GIVE_UP_MS,
    });
    expect(t).toMatchObject({ phase: 'failed', failure: 'timedOut' });
  });

  it('reports a server without OpenWA set up', () => {
    const s = run(
      { type: 'start' },
      { type: 'createFailed', notConfigured: true }
    );
    expect(s).toMatchObject({ phase: 'failed', failure: 'notConfigured' });
    expect(needsCleanup(s)).toBe(false);
  });

  it('carries the server text when create fails', () => {
    const s = run(
      { type: 'start' },
      { type: 'createFailed', notConfigured: false, error: 'Gateway down' }
    );
    expect(s).toMatchObject({ failure: 'createFailed', error: 'Gateway down' });
  });

  it('cancel while linking asks for cleanup and ignores late polls', () => {
    let s = run(...created, {
      type: 'polled',
      status: 'qr_ready',
      qrCode: 'q',
      at: T0,
    });
    s = connectReducer(s, { type: 'cancel' });
    expect(s.phase).toBe('cancelled');
    expect(needsCleanup(s)).toBe(true);
    const late = connectReducer(s, {
      type: 'polled',
      status: 'ready',
      at: T0 + 1,
    });
    expect(late.phase).toBe('cancelled');
  });

  it('cannot cancel a connected number', () => {
    const s = run(...created, { type: 'polled', status: 'ready', at: T0 });
    expect(connectReducer(s, { type: 'cancel' }).phase).toBe('connected');
  });

  it('ignores a second start while creating', () => {
    const s = run({ type: 'start' });
    expect(connectReducer(s, { type: 'start' })).toBe(s);
  });
});

describe('openwaStatusLabelKey', () => {
  it('maps every OpenWA status to a label key', () => {
    expect(openwaStatusLabelKey('created')).toBe('starting');
    expect(openwaStatusLabelKey('initializing')).toBe('starting');
    expect(openwaStatusLabelKey('qr_ready')).toBe('scan');
    expect(openwaStatusLabelKey('authenticating')).toBe('linking');
    expect(openwaStatusLabelKey('ready')).toBe('ready');
    expect(openwaStatusLabelKey('disconnected')).toBe('disconnected');
    expect(openwaStatusLabelKey('action_required')).toBe('actionRequired');
    expect(openwaStatusLabelKey('failed')).toBe('failed');
    expect(openwaStatusLabelKey('something_new')).toBe('starting');
  });
});
