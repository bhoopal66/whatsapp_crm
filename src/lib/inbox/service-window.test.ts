import { describe, expect, it } from 'vitest';

import { SERVICE_WINDOW_MS } from '@/lib/compass/meta-template';

import {
  describeAgo,
  latestCustomerMessageAt,
  serviceWindowCountdown,
  serviceWindowState,
} from './service-window';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('serviceWindowState', () => {
  it('is unknown until the last customer message is known', () => {
    expect(serviceWindowState(undefined, NOW)).toEqual({ kind: 'unknown' });
  });

  it('is unknown for an unreadable timestamp, so nothing is blocked', () => {
    expect(serviceWindowState('not a date', NOW)).toEqual({ kind: 'unknown' });
  });

  it('is closed when the customer never wrote', () => {
    expect(serviceWindowState(null, NOW)).toEqual({
      kind: 'closed',
      agoMs: null,
    });
  });

  it('is open with the time left inside the window', () => {
    expect(serviceWindowState(ago(HOUR), NOW)).toEqual({
      kind: 'open',
      msLeft: SERVICE_WINDOW_MS - HOUR,
    });
  });

  it('closes at the same edge as the Compass send path', () => {
    expect(serviceWindowState(ago(SERVICE_WINDOW_MS - 1), NOW).kind).toBe(
      'open'
    );
    expect(serviceWindowState(ago(SERVICE_WINDOW_MS), NOW)).toEqual({
      kind: 'closed',
      agoMs: SERVICE_WINDOW_MS,
    });
  });

  it('is closed with how long ago the customer wrote', () => {
    expect(serviceWindowState(ago(26 * HOUR), NOW)).toEqual({
      kind: 'closed',
      agoMs: 26 * HOUR,
    });
  });
});

describe('latestCustomerMessageAt', () => {
  const row = (conversation_id: string, sender_type: string, ms: number) => ({
    conversation_id,
    sender_type,
    created_at: ago(ms),
  });

  it('takes the newest customer message of the chat', () => {
    const rows = [
      row('c1', 'customer', 5 * HOUR),
      row('c1', 'customer', 2 * HOUR),
      row('c1', 'agent', HOUR),
      row('c1', 'bot', MIN),
    ];
    expect(latestCustomerMessageAt(rows, 'c1')).toBe(ago(2 * HOUR));
  });

  it('ignores another chat and answers null with no customer message', () => {
    const rows = [row('c2', 'customer', HOUR), row('c1', 'agent', MIN)];
    expect(latestCustomerMessageAt(rows, 'c1')).toBeNull();
    expect(latestCustomerMessageAt(rows, null)).toBeNull();
    expect(latestCustomerMessageAt([], 'c1')).toBeNull();
  });
});

describe('describeAgo', () => {
  it('counts hours up to 48', () => {
    expect(describeAgo(26 * HOUR + 59 * MIN)).toEqual({
      unit: 'hours',
      count: 26,
    });
    expect(describeAgo(48 * HOUR + 30 * MIN)).toEqual({
      unit: 'hours',
      count: 48,
    });
  });

  it('switches to days past 48 hours', () => {
    expect(describeAgo(49 * HOUR)).toEqual({ unit: 'days', count: 2 });
    expect(describeAgo(3 * 24 * HOUR + 5 * HOUR)).toEqual({
      unit: 'days',
      count: 3,
    });
  });
});

describe('serviceWindowCountdown', () => {
  it('shows only under 2 hours left', () => {
    expect(serviceWindowCountdown({ kind: 'open', msLeft: 2 * HOUR })).toBe(
      null
    );
    expect(
      serviceWindowCountdown({ kind: 'open', msLeft: HOUR + 12 * MIN })
    ).toEqual({ hours: 1, minutes: 12 });
  });

  it('rounds up to the minute, never showing 0 m while open', () => {
    expect(serviceWindowCountdown({ kind: 'open', msLeft: 30_000 })).toEqual({
      hours: 0,
      minutes: 1,
    });
    expect(
      serviceWindowCountdown({ kind: 'open', msLeft: 59 * MIN + 1 })
    ).toEqual({ hours: 1, minutes: 0 });
  });

  it('shows nothing when not open', () => {
    expect(serviceWindowCountdown(null)).toBeNull();
    expect(serviceWindowCountdown({ kind: 'unknown' })).toBeNull();
    expect(serviceWindowCountdown({ kind: 'closed', agoMs: null })).toBeNull();
  });
});
