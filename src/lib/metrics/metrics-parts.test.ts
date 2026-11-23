import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bearerMatches, metricsToken } from './auth';
import { collectInboundQueue, readInboundQueueStats } from './inbound-queue';
import { collectOutbox, parseOutboxStats, readOutboxStats } from './outbox';
import { collectPosture, postureLogLine, startupPosture } from './posture';
import { collectProcess } from './process';
import { Registry } from './registry';

afterEach(() => vi.restoreAllMocks());

const TOKEN = 'm'.repeat(40);

describe('inbound queue', () => {
  it('renders the gauges, and only stats_up 0 when unreadable', () => {
    const r = new Registry();
    collectInboundQueue(r, {
      pending: 3,
      dead: 1,
      oldestPendingAgeSeconds: 42,
    });
    let out = r.render();
    expect(out).toContain('wacrm_inbound_queue_stats_up 1');
    expect(out).toContain('wacrm_inbound_queue_pending 3');
    expect(out).toContain('wacrm_inbound_queue_dead 1');
    expect(out).toContain('wacrm_inbound_queue_oldest_pending_age_seconds 42');
    collectInboundQueue(r, null);
    out = r.render();
    expect(out).toContain('wacrm_inbound_queue_stats_up 0');
    expect(out).not.toContain('wacrm_inbound_queue_pending 3');
  });

  it('answers null for an error, a missing 264 and a slow database', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = (answer: () => Promise<unknown>) => ({ rpc: answer }) as never;
    for (const code of ['57014', 'PGRST202']) {
      expect(
        await readInboundQueueStats(
          db(async () => ({ data: null, error: { code } }))
        )
      ).toBeNull();
    }
    expect(
      await readInboundQueueStats(db(() => new Promise(() => {})), 5)
    ).toBeNull();
  });
});

describe('metricsToken / bearerMatches', () => {
  it('is off unset or under 32 characters, logging without the value', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(metricsToken({})).toBeNull();
    expect(metricsToken({ METRICS_TOKEN: 'short-secret-value' })).toBeNull();
    for (const [line] of log.mock.calls)
      expect(String(line)).not.toContain('short-secret-value');
    expect(metricsToken({ METRICS_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
  });

  it('accepts only the exact bearer token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(null, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
  });
});

const STATS = {
  rows: [
    { status: 'queued', channel: 'whatsapp', count: 3 },
    { status: 'held', channel: 'sms', count: 2 },
  ],
  held: [{ reason: 'channel_not_connected', channel: 'sms', count: 2 }],
  oldest_queued_age_seconds: 120,
  terminal_failed: 1,
};

describe('outbox stats', () => {
  it('parses the function result, dropping malformed entries', () => {
    expect(
      parseOutboxStats({
        ...STATS,
        rows: [...STATS.rows, { status: 'x' }, 'junk'],
      })
    ).toEqual({
      rows: [
        { status: 'queued', channel: 'whatsapp', count: 3 },
        { status: 'held', channel: 'sms', count: 2 },
      ],
      held: [{ reason: 'channel_not_connected', channel: 'sms', count: 2 }],
      oldestQueuedAgeSeconds: 120,
      terminalFailed: 1,
    });
    expect(parseOutboxStats(null)).toBeNull();
    expect(parseOutboxStats({ rows: 'x' })).toBeNull();
  });

  it('renders the gauges, and only stats_up 0 when the queue could not be read', () => {
    const r = new Registry();
    collectOutbox(r, parseOutboxStats(STATS));
    let out = r.render();
    expect(out).toContain('wacrm_outbox_stats_up 1');
    expect(out).toContain(
      'wacrm_outbox_rows{state="queued",channel="whatsapp"} 3'
    );
    expect(out).toContain(
      'wacrm_outbox_held_rows{reason="channel_not_connected",channel="sms"} 2'
    );
    expect(out).toContain('wacrm_outbox_oldest_queued_age_seconds 120');
    expect(out).toContain('wacrm_outbox_terminal_failed 1');
    collectOutbox(r, null);
    out = r.render();
    expect(out).toContain('wacrm_outbox_stats_up 0');
    expect(out).not.toMatch(/^wacrm_outbox_rows\{/m);
    expect(out).not.toMatch(/^wacrm_outbox_terminal_failed /m);
  });

  const db = (rpc: unknown) =>
    ({ rpc: () => ({ abortSignal: () => rpc }) }) as unknown as SupabaseClient;

  it('reads through the RPC, and never throws', async () => {
    expect(
      await readOutboxStats(db(Promise.resolve({ data: STATS, error: null })))
    ).toMatchObject({ terminalFailed: 1 });
    expect(
      await readOutboxStats(
        db(Promise.resolve({ data: null, error: { code: '42883' } }))
      )
    ).toBeNull();
    expect(
      await readOutboxStats(db(Promise.reject(new Error('down'))))
    ).toBeNull();
  });

  it('gives up on a call that never answers', async () => {
    const started = Date.now();
    expect(await readOutboxStats(db(new Promise(() => {})), 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('posture', () => {
  it('reports configured and unverified integrations, never a value', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      DINSTAR_BASE_URL: 'https://gw.example',
      DINSTAR_USERNAME: 'u',
      DINSTAR_PASSWORD: 'p-secret-value',
      TYPESAFE_API_KEY: 'ts-secret-value',
    };
    const p = startupPosture(env);
    const by = Object.fromEntries(p.map((i) => [i.name, i]));
    expect(by.sms_sender).toMatchObject({ configured: true, unverified: true });
    expect(by.rcs_sender).toMatchObject({ configured: false });
    expect(by.typesafe).toMatchObject({ configured: true, unverified: false });
    const line = postureLogLine(p);
    expect(line).toContain('UNVERIFIED wire format in use: sms_sender');
    expect(line).not.toContain('secret-value');
    expect(postureLogLine(startupPosture({}))).toBe(
      '[posture] integrations on: none'
    );

    const r = new Registry();
    collectPosture(r, p);
    const out = r.render();
    expect(out).toContain('wacrm_integration_configured{name="sms_sender"} 1');
    expect(out).toContain('wacrm_integration_unverified{name="sms_sender"} 1');
    expect(out).toContain('wacrm_integration_unverified{name="typesafe"} 0');
    expect(out).not.toContain('secret-value');
  });
});

describe('process gauges', () => {
  it('sets uptime, memory, heap and event loop lag', () => {
    const r = new Registry();
    collectProcess(r);
    const out = r.render();
    for (const name of [
      'process_uptime_seconds',
      'process_resident_memory_bytes',
      'nodejs_heap_used_bytes',
      'nodejs_eventloop_lag_p99_seconds',
    ]) {
      expect(out).toMatch(new RegExp(`^${name} [0-9.e+-]+$`, 'm'));
    }
  });
});
