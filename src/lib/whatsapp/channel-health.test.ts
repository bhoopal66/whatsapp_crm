import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  channels: [] as unknown[],
}));

vi.mock('./channels', () => ({
  loadWhapiChannelsForHealth: async () => h.channels,
}));

import {
  channelHealthAlert,
  everyInterval,
  nextHealth,
  pairedNumberPatch,
  runChannelHealthCheck,
  type HealthVerdict,
} from './channel-health';
import type { ChannelProbe } from './provider';
import type { WhatsAppChannel } from './channels';

const up = (status: string) => ({ ok: true as const, status });
const refused = (httpStatus: number | null) => ({
  ok: false as const,
  httpStatus,
  message: 'Whapi request failed: timeout',
});

describe('nextHealth', () => {
  it('marks a paired channel connected, and alerts only when it was down', () => {
    expect(nextHealth('disconnected', up('AUTH'))).toMatchObject({
      status: 'connected',
      notify: 'up',
      reason: 'paired',
    });
    expect(nextHealth('connected', up('AUTH')).notify).toBeNull();
  });

  it('marks a logged-out (QR) or errored channel disconnected', () => {
    expect(nextHealth('connected', up('QR'))).toMatchObject({
      status: 'disconnected',
      notify: 'down',
      reason: 'logged_out',
      detail: 'QR',
    });
    expect(nextHealth('connected', up('ERROR'))).toMatchObject({
      status: 'disconnected',
      notify: 'down',
      reason: 'error_state',
    });
  });

  it('alerts once per transition, not on every tick', () => {
    expect(nextHealth('disconnected', up('QR')).notify).toBeNull();
    expect(nextHealth('disconnected', refused(401)).notify).toBeNull();
  });

  it('treats a refused probe as down: token (401/403), channel gone (404), billing (402)', () => {
    for (const code of [401, 403, 404]) {
      expect(nextHealth('connected', refused(code))).toMatchObject({
        status: 'disconnected',
        notify: 'down',
        reason: 'token_refused',
        detail: `HTTP ${code}`,
      });
    }
    expect(nextHealth('connected', refused(402))).toMatchObject({
      status: 'disconnected',
      reason: 'billing',
    });
  });

  it('leaves the status alone on anything ambiguous', () => {
    // LAUNCH/INIT: starting or syncing (a re-pair passes through them).
    // NOT_INIT: what a body with no status text maps to. SLEEP: a word
    // outside the enum. 5xx/timeout: Whapi's blip, not the number's.
    for (const probe of [
      up('LAUNCH'),
      up('INIT'),
      up('NOT_INIT'),
      up('SLEEP'),
      refused(503),
      refused(500),
      refused(null),
    ]) {
      for (const prev of ['connected', 'disconnected']) {
        expect(nextHealth(prev, probe)).toMatchObject({
          status: prev,
          notify: null,
          reason: 'inconclusive',
        });
      }
    }
  });
});

describe('channelHealthAlert', () => {
  const channel = {
    label: null,
    wabaId: '971581842504',
    phoneNumberId: 'NIGHTW-JJC9J',
  };
  const down = (reason: HealthVerdict['reason'], detail = 'QR') =>
    ({
      status: 'disconnected',
      notify: 'down',
      reason,
      detail,
    }) as HealthVerdict;

  it('names the number, the physical fix and who does it for a logout', () => {
    const alert = channelHealthAlert(channel, down('logged_out'))!;
    expect(alert.type).toBe('channel_disconnected');
    expect(alert.title).toBe('WhatsApp number …2504 is logged out');
    expect(alert.body).toContain('+971581842504');
    expect(alert.body).toContain('panel.whapi.cloud');
    expect(alert.body).toMatch(/whoever holds that phone scans it/);
    expect(alert.body).toMatch(/Linked devices → Link a device/);
    expect(alert.body).toMatch(/Do not re-save the token/);
  });

  it('sends a revoked token to Settings instead', () => {
    const alert = channelHealthAlert(
      channel,
      down('token_refused', 'HTTP 401')
    )!;
    expect(alert.title).toBe('WhatsApp number …2504 is disconnected');
    expect(alert.body).toContain('HTTP 401');
    expect(alert.body).toMatch(/Settings → WhatsApp/);
  });

  it('words the error state and a lapsed subscription', () => {
    expect(channelHealthAlert(channel, down('error_state'))!.body).toMatch(
      /error state/
    );
    expect(
      channelHealthAlert(channel, down('billing', 'HTTP 402'))!.body
    ).toMatch(/subscription has lapsed/);
  });

  it('uses the label when there is one, and survives a row with no number', () => {
    expect(
      channelHealthAlert({ ...channel, label: 'Support' }, down('logged_out'))!
        .title
    ).toBe('WhatsApp number Support (…2504) is logged out');
    // The default label is the number itself: not repeated.
    expect(
      channelHealthAlert(
        { ...channel, label: 'WhatsApp 971581842504' },
        down('logged_out')
      )!.title
    ).toBe('WhatsApp number …2504 is logged out');
    const bare = channelHealthAlert(
      { ...channel, wabaId: null },
      down('logged_out')
    )!;
    expect(bare.title).toBe('WhatsApp number NIGHTW-JJC9J is logged out');
    expect(bare.body).toContain('The phone with this number');
  });

  it('announces a recovery and points at what may have been missed', () => {
    const alert = channelHealthAlert(channel, {
      status: 'connected',
      notify: 'up',
      reason: 'paired',
      detail: 'AUTH',
    })!;
    expect(alert.type).toBe('channel_reconnected');
    expect(alert.title).toBe('WhatsApp number …2504 is connected again');
    expect(alert.body).toMatch(/re-send any replies that failed/);
  });

  it('has nothing to say without a transition', () => {
    expect(
      channelHealthAlert(channel, {
        status: 'connected',
        notify: null,
        reason: 'paired',
        detail: 'AUTH',
      })
    ).toBeNull();
  });
});

// ------------------------------------------------------------
// The sweep, over a recording Supabase fake.
// ------------------------------------------------------------

interface Op {
  table: string;
  calls: Array<[string, unknown[]]>;
}

function fakeAdmin(opts: {
  /** Row ids whose conditional update matches nothing (moved by someone else). */
  stale?: string[];
  /** Row ids whose update errors. */
  broken?: string[];
  profiles?: Array<{ user_id: string }>;
  /** The profiles read errors. */
  profilesError?: string;
  /** The notifications insert errors (e.g. 065's CHECK not applied yet). */
  insertError?: string;
  /** How the second write to a row — the undo — answers. */
  undo?: 'moved' | 'broken';
}) {
  const ops: Op[] = [];
  const writes = new Map<string, number>();
  const db = {
    from(table: string) {
      const op: Op = { table, calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'insert', 'eq', 'in', 'is']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: unknown) => unknown) => {
        if (table === 'whatsapp_config') {
          const id = op.calls.find(
            ([m, a]) => m === 'eq' && a[0] === 'id'
          )?.[1][1] as string;
          const nth = (writes.get(id) ?? 0) + 1;
          writes.set(id, nth);
          if (nth === 2 && opts.undo === 'broken') {
            return resolve({ data: null, error: { message: 'undo boom' } });
          }
          if (nth === 2 && opts.undo === 'moved') {
            return resolve({ data: [], error: null });
          }
          if (opts.broken?.includes(id)) {
            return resolve({ data: null, error: { message: 'boom' } });
          }
          return resolve({
            data: opts.stale?.includes(id) ? [] : [{ id }],
            error: null,
          });
        }
        if (table === 'profiles') {
          if (opts.profilesError) {
            return resolve({
              data: null,
              error: { message: opts.profilesError },
            });
          }
          return resolve({
            data: opts.profiles ?? [{ user_id: 'owner-1' }],
            error: null,
          });
        }
        if (table === 'notifications' && opts.insertError) {
          return resolve({ error: { message: opts.insertError } });
        }
        return resolve({ error: null });
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const calls = (table: string, method: string) =>
    ops
      .filter((o) => o.table === table)
      .flatMap((o) => o.calls.filter(([m]) => m === method).map(([, a]) => a));
  return { db, ops, calls };
}

function whapi(
  id: string,
  status: string,
  accountId = 'acct-1'
): WhatsAppChannel {
  return {
    id,
    accountId,
    provider: 'whapi',
    label: null,
    phoneNumberId: `ch-${id}`,
    wabaId: '971581842504',
    accessToken: `tok-${id}`,
    appSecret: null,
    isPrimary: true,
    mirrorInboundMedia: true,
    status,
  };
}

const probeResult = (status: string): ChannelProbe => ({
  status,
  authorized: status === 'AUTH',
  phone: null,
});

const NOW = new Date('2026-09-29T13:00:00Z');

describe('runChannelHealthCheck', () => {
  beforeEach(() => {
    h.channels = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a logged-out number down, scoped to its account, and alerts owners and admins', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, calls } = fakeAdmin({
      profiles: [{ user_id: 'owner-1' }, { user_id: 'admin-2' }],
    });

    const summary = await runChannelHealthCheck(db, {
      probe: async () => probeResult('QR'),
      now: () => NOW,
    });

    expect(summary).toEqual({ checked: 1, changed: 1, notified: 2, failed: 0 });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ status: 'disconnected' }],
    ]);
    // By id AND account, and only if nobody moved it since it was read.
    expect(calls('whatsapp_config', 'eq')).toEqual([
      ['id', 'w1'],
      ['account_id', 'acct-1'],
      ['status', 'connected'],
    ]);
    expect(calls('profiles', 'eq')).toEqual([['account_id', 'acct-1']]);
    expect(calls('profiles', 'in')).toEqual([
      ['account_role', ['owner', 'admin']],
    ]);
    const [[rows]] = calls('notifications', 'insert') as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows.map((r) => r.user_id)).toEqual(['owner-1', 'admin-2']);
    expect(rows[0]).toMatchObject({
      account_id: 'acct-1',
      type: 'channel_disconnected',
      conversation_id: null,
      title: 'WhatsApp number …2504 is logged out',
    });
  });

  it('stamps connected_at when a number comes back', async () => {
    h.channels = [whapi('w1', 'disconnected')];
    const { db, calls } = fakeAdmin({});
    await runChannelHealthCheck(db, {
      probe: async () => probeResult('AUTH'),
      now: () => NOW,
    });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ status: 'connected', connected_at: NOW.toISOString() }],
    ]);
    const [[rows]] = calls('notifications', 'insert') as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows[0].type).toBe('channel_reconnected');
  });

  it('writes nothing when nothing changed or the probe is inconclusive', async () => {
    h.channels = [whapi('w1', 'connected'), whapi('w2', 'connected')];
    const { db, ops } = fakeAdmin({});
    const summary = await runChannelHealthCheck(db, {
      probe: async (c) => probeResult(c.id === 'w1' ? 'AUTH' : 'LAUNCH'),
    });
    expect(summary).toEqual({ checked: 2, changed: 0, notified: 0, failed: 0 });
    expect(ops).toEqual([]);
  });

  it('treats a refused probe as down and a gateway timeout as nothing', async () => {
    h.channels = [whapi('w1', 'connected'), whapi('w2', 'connected')];
    const { db, calls } = fakeAdmin({});
    const summary = await runChannelHealthCheck(db, {
      probe: async (c) => {
        throw Object.assign(new Error('x'), {
          status: c.id === 'w1' ? 401 : 503,
        });
      },
    });
    expect(summary.changed).toBe(1);
    expect(calls('whatsapp_config', 'eq')[0]).toEqual(['id', 'w1']);
  });

  it('does not alert when another writer moved the row first', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, calls } = fakeAdmin({ stale: ['w1'] });
    const summary = await runChannelHealthCheck(db, {
      probe: async () => probeResult('QR'),
    });
    expect(summary.changed).toBe(0);
    expect(calls('notifications', 'insert')).toEqual([]);
  });

  it('keeps going past a number whose write fails', async () => {
    h.channels = [whapi('w1', 'connected'), whapi('w2', 'connected', 'acct-2')];
    const { db, calls } = fakeAdmin({ broken: ['w1'] });
    const summary = await runChannelHealthCheck(db, {
      probe: async () => probeResult('QR'),
    });
    expect(summary).toMatchObject({ checked: 2, changed: 1, failed: 1 });
    const [[rows]] = calls('notifications', 'insert') as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows[0].account_id).toBe('acct-2');
  });

  it('puts the status back when the alert cannot be saved, so the next tick alerts', async () => {
    // Before 065 widens the CHECK, the insert fails. Moving the status
    // anyway made the next tick see nothing to report: the owner was
    // never told the number was logged out.
    h.channels = [whapi('w1', 'connected')];
    const first = fakeAdmin({
      insertError:
        'new row for relation "notifications" violates check constraint "notifications_type_check"',
    });
    const probe = async () => probeResult('QR');

    const failed = await runChannelHealthCheck(first.db, { probe });
    expect(failed).toEqual({ checked: 1, changed: 0, notified: 0, failed: 1 });
    expect(first.calls('whatsapp_config', 'update')).toEqual([
      [{ status: 'disconnected' }],
      [{ status: 'connected' }],
    ]);
    // The undo only reverts what this tick wrote.
    expect(first.calls('whatsapp_config', 'eq').slice(3)).toEqual([
      ['id', 'w1'],
      ['account_id', 'acct-1'],
      ['status', 'disconnected'],
    ]);

    // Next tick: the row still says 'connected', so the transition and
    // its alert run again.
    h.channels = [whapi('w1', 'connected')];
    const second = fakeAdmin({});
    const summary = await runChannelHealthCheck(second.db, { probe });
    expect(summary).toEqual({ checked: 1, changed: 1, notified: 1, failed: 0 });
    const [[rows]] = second.calls('notifications', 'insert') as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows[0]).toMatchObject({
      type: 'channel_disconnected',
      title: 'WhatsApp number …2504 is logged out',
    });
  });

  it('puts the status back when the owners cannot be read', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, calls } = fakeAdmin({ profilesError: 'pooler timeout' });
    const summary = await runChannelHealthCheck(db, {
      probe: async () => probeResult('QR'),
    });
    expect(summary).toMatchObject({ changed: 0, failed: 1 });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ status: 'disconnected' }],
      [{ status: 'connected' }],
    ]);
    expect(calls('notifications', 'insert')).toEqual([]);
  });

  it('keeps a recovered number connected when its alert cannot be saved', async () => {
    // Putting an 'up' change back left a working number 'disconnected'
    // (Compass refused every customer on it) for as long as the alert
    // kept failing, which before 065 is every tick. The lost "connected
    // again" notice is the cheaper failure.
    for (const failure of [
      { profilesError: 'pooler timeout' },
      {
        insertError:
          'new row for relation "notifications" violates check constraint "notifications_type_check"',
      },
    ]) {
      h.channels = [whapi('w1', 'disconnected')];
      const { db, calls } = fakeAdmin(failure);
      const summary = await runChannelHealthCheck(db, {
        probe: async () => probeResult('AUTH'),
        now: () => NOW,
      });
      expect(summary).toMatchObject({ changed: 0, failed: 1 });
      expect(calls('whatsapp_config', 'update')).toEqual([
        [{ status: 'connected', connected_at: NOW.toISOString() }],
      ]);
    }
  });

  it('still fails the number when the undo itself cannot be written', async () => {
    for (const undo of ['moved', 'broken'] as const) {
      h.channels = [whapi('w1', 'connected')];
      const { db, calls } = fakeAdmin({ insertError: 'boom', undo });
      const summary = await runChannelHealthCheck(db, {
        probe: async () => probeResult('QR'),
      });
      expect(summary).toMatchObject({ changed: 0, failed: 1 });
      expect(calls('whatsapp_config', 'update')).toHaveLength(2);
    }
  });

  it('does not undo a transition when the account has nobody to tell', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, calls } = fakeAdmin({ profiles: [] });
    const summary = await runChannelHealthCheck(db, {
      probe: async () => probeResult('QR'),
    });
    expect(summary).toEqual({ checked: 1, changed: 1, notified: 0, failed: 0 });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ status: 'disconnected' }],
    ]);
  });

  it('skips a number the probe has nothing to say about', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, ops } = fakeAdmin({});
    const summary = await runChannelHealthCheck(db, {
      probe: async () => null,
    });
    expect(summary.checked).toBe(0);
    expect(ops).toEqual([]);
  });

  it('stores the number a re-paired channel now reports, and alerts with it', async () => {
    h.channels = [whapi('w1', 'disconnected')];
    const { db, calls } = fakeAdmin({});
    const summary = await runChannelHealthCheck(db, {
      probe: async () => ({ ...probeResult('AUTH'), phone: '971501234567' }),
      now: () => NOW,
    });
    expect(summary).toEqual({ checked: 1, changed: 1, notified: 1, failed: 0 });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ waba_id: '971501234567' }],
      [{ status: 'connected', connected_at: NOW.toISOString() }],
    ]);
    // Only over the number it replaces: a token re-save at the same
    // moment wins.
    expect(calls('whatsapp_config', 'eq').slice(0, 4)).toEqual([
      ['id', 'w1'],
      ['account_id', 'acct-1'],
      ['provider', 'whapi'],
      ['waba_id', '971581842504'],
    ]);
    const [[rows]] = calls('notifications', 'insert') as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows[0].title).toBe('WhatsApp number …4567 is connected again');
  });

  it('leaves the stored number alone when the same phone is paired', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, ops } = fakeAdmin({});
    await runChannelHealthCheck(db, {
      probe: async () => ({ ...probeResult('AUTH'), phone: '971581842504' }),
    });
    expect(ops).toEqual([]);
  });

  it('still checks health when storing the number fails', async () => {
    h.channels = [whapi('w1', 'connected')];
    const { db, calls } = fakeAdmin({ broken: ['w1'] });
    const summary = await runChannelHealthCheck(db, {
      probe: async () => ({ ...probeResult('AUTH'), phone: '971501234567' }),
    });
    expect(summary).toEqual({ checked: 1, changed: 0, notified: 0, failed: 0 });
    expect(calls('whatsapp_config', 'update')).toEqual([
      [{ waba_id: '971501234567' }],
    ]);
  });
});

describe('pairedNumberPatch', () => {
  const row = { wabaId: '971581842504', label: 'Support' };

  it('stores a different paired number and keeps a typed name', () => {
    expect(pairedNumberPatch(row, '971501234567')).toEqual({
      waba_id: '971501234567',
    });
  });

  it('moves a default label along with the number', () => {
    expect(
      pairedNumberPatch(
        { wabaId: '971581842504', label: 'WhatsApp 971581842504' },
        '971501234567'
      )
    ).toEqual({ waba_id: '971501234567', label: 'WhatsApp 971501234567' });
  });

  it('fills in a number that was never stored', () => {
    expect(
      pairedNumberPatch({ wabaId: null, label: null }, '971501234567')
    ).toEqual({ waba_id: '971501234567' });
  });

  it('changes nothing for the same digits or no paired phone', () => {
    expect(pairedNumberPatch(row, '+971 58 184 2504')).toBeNull();
    expect(pairedNumberPatch(row, null)).toBeNull();
    expect(pairedNumberPatch(row, '')).toBeNull();
  });
});

describe('everyInterval', () => {
  it('lets one call through per interval', () => {
    const due = everyInterval(300_000);
    expect(due(1_000_000)).toBe(true);
    expect(due(1_000_000 + 60_000)).toBe(false);
    expect(due(1_000_000 + 294_999)).toBe(false);
    expect(due(1_000_000 + 300_000)).toBe(true);
    expect(due(1_000_000 + 300_001)).toBe(false);
  });

  it('does not skip a once-a-minute job when the ping lands a little early', () => {
    const due = everyInterval(60_000);
    expect(due(1_000_000)).toBe(true);
    // The next ping arrives 30 ms short of a minute: still this minute's run.
    expect(due(1_000_000 + 59_970)).toBe(true);
    // A second ping in the same minute is still refused.
    expect(due(1_000_000 + 59_970 + 20_000)).toBe(false);
    // Slack is 5 s at most.
    expect(due(1_000_000 + 59_970 + 54_999)).toBe(false);
    expect(due(1_000_000 + 59_970 + 55_000)).toBe(true);
  });
});
