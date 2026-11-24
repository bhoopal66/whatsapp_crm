// A scheduled or API campaign whose pass ended with recipients still
// pending is continued by a later tick. The real claim, planner and delivery run
// against a stateful fake; only the gateway is mocked.

import { readdirSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakeDb,
  type FakeOptions,
  type Row,
} from '@/lib/whatsapp/broadcast.fake';

const h = vi.hoisted(() => ({
  db: null as unknown,
  afterCallbacks: [] as (() => Promise<void>)[],
  send: vi.fn(),
  check: vi.fn(),
}));

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => h.afterCallbacks.push(cb),
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('@/lib/whatsapp/provider', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/provider')>()),
  sendTemplate: h.send,
}));
vi.mock('@/lib/team-activity/auto-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-activity/auto-guard')>()),
  companyConversationId: async () => 'conv-1',
  checkAutoStartAllowed: h.check,
}));

import { GET } from './route';
import { campaignDailyLimitMessage } from '@/lib/team-activity/auto-guard';
import { quietHoursMessage } from '@/lib/whatsapp/broadcast-core';

const NOW = new Date('2026-11-23T08:00:00Z'); // 12:00 Dubai
const QUIET = { start: '21:00', end: '08:00', tz: 'Asia/Dubai' };
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type World = ReturnType<typeof world>;

/** `sizes`: how many pending recipients each campaign (bc-1, bc-2…) has. */
function world(sizes: number[], broadcast: Row = {}, provider = 'meta') {
  const pad = (i: number) => String(i).padStart(5, '0');
  return {
    broadcasts: sizes.map((_, b): Row => ({
      id: `bc-${b + 1}`,
      account_id: 'acct-1',
      status: 'sending',
      scheduled_at: ago(DAY),
      audience_filter: { type: 'all' },
      created_at: ago(2 * DAY),
      updated_at: ago(31 * MIN - b * 1000),
      delivery_locked_at: null,
      quiet_hours: null,
      template_name: 'promo',
      template_language: 'en_US',
      ...broadcast,
    })),
    broadcast_recipients: sizes.flatMap((n, b) =>
      Array.from({ length: n }, (_, i): Row => ({
        id: `bc-${b + 1}-${pad(i)}`,
        broadcast_id: `bc-${b + 1}`,
        contact_id: null,
        status: 'pending',
        error_message: null,
        created_at: '2026-11-22T00:00:00Z',
        template_params: [],
        contact: { phone: `97150${b}0${pad(i)}`, opted_out_at: null },
      }))
    ),
    whatsapp_config: [
      {
        id: 'cfg-1',
        account_id: 'acct-1',
        provider,
        phone_number_id: 'pn-1',
        access_token: 'tok',
        whapi_token: 'tok',
        whapi_channel_id: 'ch-1',
        is_primary: true,
        status: 'connected',
      } as Row,
    ],
    message_templates: [
      {
        id: 't-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'promo',
        language: 'en_US',
        category: 'Marketing',
        body_text: 'Hi',
        status: 'APPROVED',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as Row,
    ],
  };
}

function use(w: World, fail?: FakeOptions['fail']): World {
  h.db = Object.assign(
    fakeDb(w, {
      fail,
      // The `set_updated_at` trigger (migration 001).
      onUpdate: (table, _patch, rows) => {
        if (table !== 'broadcasts') return;
        for (const r of rows) r.updated_at = new Date().toISOString();
      },
    }),
    { rpc: async () => ({ data: 0, error: null }) }
  );
  return w;
}

const tick = async () =>
  (
    await GET(
      new Request('http://localhost/api/whatsapp/broadcast/cron', {
        headers: { 'x-cron-secret': 's3cret' },
      })
    )
  ).json();
/** Let the passes the ticks started run. */
const runPasses = async () => {
  for (const cb of h.afterCallbacks.splice(0)) await cb();
};
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const stopAt = (w: World, reason: string) => {
  w.broadcast_recipients[0].error_message = reason;
};
const DAILY = campaignDailyLimitMessage({ blocked: true, limit: 50 });

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  h.afterCallbacks.length = 0;
  h.send.mockReset().mockImplementation(async () => ({ messageId: 'wamid.1' }));
  h.check.mockReset().mockResolvedValue({ blocked: false });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('continuing a scheduled campaign', () => {
  it('sends a capped campaign to the end, each customer once', async () => {
    const w = use(world([1003]));
    expect(await tick()).toEqual({
      started: 1,
      deferred: 0,
      skipped: 0,
      reconciled: 0,
    });
    // The pass is running: the next tick leaves it alone.
    expect(await tick()).toMatchObject({ started: 0 });
    await runPasses();
    expect(h.send).toHaveBeenCalledTimes(1000);
    expect(w.broadcasts[0]).toMatchObject({
      status: 'sending',
      delivery_locked_at: null,
    });

    expect(await tick()).toMatchObject({ started: 1 });
    await runPasses();
    const to = h.send.mock.calls.map(([args]) => args.to);
    expect(to).toHaveLength(1003);
    expect(new Set(to).size).toBe(1003);
    expect(w.broadcasts[0].status).toBe('sent');
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });
  });

  it('leaves one whose lock is fresh, and takes one whose lock is stale', async () => {
    const w = use(world([2], { delivery_locked_at: ago(29 * MIN) }));
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });

    w.broadcasts[0].delivery_locked_at = ago(31 * MIN);
    expect(await tick()).toMatchObject({ started: 1 });
  });

  it('starts one pass for two ticks at once', async () => {
    use(world([2]));
    const ticks = await Promise.all([tick(), tick()]);
    expect(ticks.map((t) => t.started).sort()).toEqual([0, 1]);
    expect(h.afterCallbacks).toHaveLength(1);
  });

  it('starts one campaign per tick; one with nothing left does not use it', async () => {
    const w = use(world([1, 1, 1]));
    w.broadcast_recipients[0].status = 'sent';
    expect(await tick()).toMatchObject({ started: 1, skipped: 1 });

    expect(w.broadcasts[0]).toMatchObject({
      status: 'sent',
      delivery_locked_at: null,
    });
    expect(w.broadcasts[1].delivery_locked_at).not.toBeNull();
    expect(w.broadcasts[2].delivery_locked_at).toBeNull();
  });

  it.each([
    ['older than 7 days', { scheduled_at: ago(0) }, 7 * DAY + MIN],
    ['not scheduled', { scheduled_at: null }, 0],
    ['already finished', { status: 'sent' }, 0],
  ])('leaves a campaign %s to a person', async (_name, row, age) => {
    const w = use(world([1], row));
    if (age) w.broadcasts[0].scheduled_at = ago(age);
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('never sends again to a row a restart caught mid-send', async () => {
    const { SEND_UNCONFIRMED_REASON } =
      await import('@/lib/broadcasts/unconfirmed-send');
    const w = use(world([2], { delivery_locked_at: ago(31 * MIN) }));
    stopAt(w, SEND_UNCONFIRMED_REASON);
    await tick();
    await runPasses();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(w.broadcast_recipients.map((r) => r.status)).toEqual([
      'failed',
      'sent',
    ]);
  });
});

describe('continuing a campaign the API created', () => {
  /** What `create_broadcast_with_recipients` leaves in the row. */
  const api = (row: Row = {}) => ({
    scheduled_at: null,
    audience_filter: null,
    created_at: ago(31 * MIN),
    ...row,
  });

  it('takes one whose lock is stale, once', async () => {
    const w = use(world([2], api({ delivery_locked_at: ago(31 * MIN) })));
    expect(await tick()).toMatchObject({ started: 1 });
    expect(await tick()).toMatchObject({ started: 0 });
    await runPasses();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(w.broadcasts[0].status).toBe('sent');
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });
  });

  it('takes one whose request never took the lock', async () => {
    use(world([1], api()));
    expect(await tick()).toMatchObject({ started: 1 });
  });

  describe('not at night', () => {
    /** The tick at `time` (UTC), in an account whose time zone is `tz`. */
    const at = (time: string, row: Row = {}, tz?: string) => {
      vi.setSystemTime(new Date(`2026-11-23T${time}Z`));
      const w = world([2], api({ created_at: ago(DAY), ...row }));
      w.broadcasts[0].updated_at = ago(31 * MIN);
      const settings: Row[] = tz
        ? [{ account_id: 'acct-1', timezone: tz }]
        : [];
      return Object.assign(w, { team_activity_settings: settings });
    };

    it.each([
      ['20:00', 0], // 00:00 in Dubai
      ['03:59', 0],
      ['04:00', 1], // 08:00
      ['16:59', 1],
      ['17:00', 0], // 21:00
    ])('at %s UTC starts %i', async (time, started) => {
      const w = use(at(time));
      const untouched = { ...w.broadcasts[0] };
      expect(await tick()).toMatchObject({ started });
      if (!started) expect(w.broadcasts[0]).toEqual(untouched);
    });

    it.each([
      ['20:00', 'America/New_York', 1], // 15:00 there
      ['08:00', 'America/New_York', 0], // 03:00
      ['08:00', 'Nowhere/Nothing', 1], // Dubai
    ])('at %s UTC in %s starts %i', async (time, tz, started) => {
      use(at(time, {}, tz));
      expect(await tick()).toMatchObject({ started });
    });

    it('stops a pass that reaches the night, to go on in the morning', async () => {
      const w = use(at('16:59'));
      h.send.mockImplementation(async () => {
        later(2 * MIN);
        return { messageId: 'wamid.1' };
      });
      await tick();
      await runPasses();
      expect(w.broadcast_recipients.map((r) => r.status)).toEqual([
        'sent',
        'pending',
      ]);

      later(11 * 60 * MIN); // 08:01 in Dubai
      expect(await tick()).toMatchObject({ started: 1 });
    });

    it('keeps its own quiet hours', async () => {
      const own = { start: '11:00', end: '13:00', tz: 'Asia/Dubai' };
      use(at('08:00', { quiet_hours: own }));
      expect(await tick()).toMatchObject({ started: 0 });
      use(at('20:00', { quiet_hours: own }));
      expect(await tick()).toMatchObject({ started: 1 });
    });

    it('is no rule for a scheduled campaign', async () => {
      use(at('20:00', { scheduled_at: '2026-11-23T10:00:00Z' }));
      expect(await tick()).toMatchObject({ started: 1 });
    });

    it('waits when the time zone cannot be read', async () => {
      use(world([1], api()), ({ table }) =>
        table === 'team_activity_settings' ? 'timeout' : null
      );
      expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    });
  });

  it('starts one pass for two ticks at once', async () => {
    use(world([2], api()));
    const ticks = await Promise.all([tick(), tick()]);
    expect(ticks.map((t) => t.started).sort()).toEqual([0, 1]);
    expect(h.afterCallbacks).toHaveLength(1);
  });

  it.each([
    ['whose lock is fresh', () => ({ delivery_locked_at: ago(29 * MIN) })],
    ['with no lock, created just now', () => ({ created_at: ago(29 * MIN) })],
    ['from the wizard', () => ({ audience_filter: { type: 'all' } })],
    ['older than 7 days', () => ({ created_at: ago(7 * DAY + MIN) })],
  ])('leaves one %s alone', async (_name, row) => {
    use(world([1], api(row())));
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('only the API leaves audience_filter null', () => {
    const read = (p: string) => readFileSync(p, 'utf8');
    const sources = (readdirSync('src', { recursive: true }) as string[])
      .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
      .map((p) => `src/${p}`);

    expect(
      sources.filter((p) =>
        read(p).includes("'create_broadcast_with_recipients'")
      )
    ).toEqual(['src/lib/whatsapp/broadcast-core.ts']);
    const writers = readdirSync('supabase/migrations').filter((f) =>
      read(`supabase/migrations/${f}`)
        .replace(/--.*$/gm, '')
        .includes('audience_filter')
    );
    expect(writers).toEqual(['001_initial_schema.sql']); // the column itself

    const wizard = 'src/hooks/use-broadcast-sending.ts';
    const draft = 'src/app/(dashboard)/broadcasts/new/page.tsx';
    expect(
      sources
        .filter((p) => /from\('broadcasts'\)\s*\.insert\(/.test(read(p)))
        .sort()
    ).toEqual([draft, wizard]);
    expect(read(wizard)).toMatch(
      /from\('broadcasts'\)\s*\.insert\(\{[^;]*\baudience_filter: \{[^;]*\bstatus: sendAt/
    );
    expect(read(draft)).toMatch(/const fields = \{[^;]*\baudience_filter: \{/);
    expect(read(draft)).toMatch(/\.insert\(\{\s*\.\.\.fields,/);
  });
});

describe('what a stopped campaign waits for', () => {
  it('the end of its quiet hours, and no longer', async () => {
    const w = use(world([1], { quiet_hours: QUIET }));
    stopAt(w, quietHoursMessage(QUIET));
    later(10 * 60 * MIN); // 22:00 Dubai
    const untouched = { ...w.broadcasts[0] };
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    expect(w.broadcasts[0]).toEqual(untouched); // not even claimed

    later(10 * 60 * MIN + MIN); // 08:01
    w.broadcasts[0].updated_at = ago(MIN);
    expect(await tick()).toMatchObject({ started: 1 });
  });

  it('a daily limit with room, asked every half hour at most', async () => {
    const w = use(world([1], {}, 'whapi'));
    stopAt(w, DAILY);
    h.check.mockResolvedValue({ blocked: true, limit: 50 });

    w.broadcasts[0].updated_at = ago(29 * MIN);
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    expect(h.check).not.toHaveBeenCalled();

    later(2 * MIN);
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    expect(h.check).toHaveBeenCalledTimes(1);
    // Refused: the rest starts over.
    later(29 * MIN);
    await tick();
    expect(h.check).toHaveBeenCalledTimes(1);

    h.check.mockResolvedValue({ blocked: false });
    later(2 * MIN);
    expect(await tick()).toMatchObject({ started: 1 });
    await runPasses();
    expect(w.broadcasts[0].status).toBe('sent');
  });

  it('a number that is connected again', async () => {
    const w = use(world([1], {}, 'whapi'));
    stopAt(w, 'The phone is logged out');
    w.whatsapp_config[0].status = 'disconnected';
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });

    w.whatsapp_config[0].status = 'connected';
    expect(await tick()).toMatchObject({ started: 1 });
  });

  it('its turn, when planning was refused; the page shows why', async () => {
    const w = use(world([2]));
    const templates = w.message_templates.splice(0);
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    expect(w.broadcast_recipients[0]).toMatchObject({
      status: 'pending',
      error_message: 'No template named "promo" exists on this account.',
    });
    expect(w.broadcasts[0]).toMatchObject({
      status: 'sending',
      delivery_locked_at: null,
    });

    w.message_templates.push(...templates);
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    later(31 * MIN);
    expect(await tick()).toMatchObject({ started: 1 });
  });

  it('a number at all: refused again only after its rest', async () => {
    const w = use(world([1]));
    w.whatsapp_config.length = 0;
    await tick();
    expect(w.broadcast_recipients[0].error_message).toMatch(/not configured/);
    later(31 * MIN);
    await tick(); // refused again, so it rests again
    expect(String(w.broadcasts[0].updated_at) > ago(MIN)).toBe(true);
  });
});

describe('a database that does not answer', () => {
  it.each(['broadcasts', 'broadcast_recipients', 'whatsapp_config'])(
    'keeps a scheduled campaign due when %s cannot be read',
    async (broken) => {
      let reads = 0;
      const w = use(world([1], { status: 'scheduled' }), ({ table, patch }) => {
        if (table !== broken || patch) return null;
        // The first read of broadcasts is the list of due campaigns.
        return ++reads === (broken === 'broadcasts' ? 2 : 1) ? 'timeout' : null;
      });
      expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
      expect(w.broadcasts[0]).toMatchObject({
        status: 'scheduled',
        delivery_locked_at: null,
      });

      expect(await tick()).toMatchObject({ started: 1 });
    }
  );

  it('leaves an unfinished campaign as it was', async () => {
    const w = use(world([1]), ({ table }) =>
      table === 'broadcast_recipients' ? 'timeout' : null
    );
    expect(await tick()).toMatchObject({ started: 0, skipped: 1 });
    expect(w.broadcasts[0].delivery_locked_at).toBeNull();
    expect(w.broadcast_recipients[0].error_message).toBeNull();
  });
});

describe('a template Meta refused', () => {
  const refused = (broadcast: Row) => {
    const w = world([2], broadcast);
    Object.assign(w.message_templates[0], {
      meta_template_id: null,
      submission_error: 'Bad footer',
    });
    return w;
  };

  it.each([
    ['when its time comes', { status: 'scheduled' }],
    ['when it is continued', { status: 'sending' }],
  ])('%s: failed with the reason, nothing sent', async (_, broadcast) => {
    const w = use(refused(broadcast));
    await tick();
    await runPasses();

    expect(h.send).not.toHaveBeenCalled();
    expect(w.broadcasts[0]).toMatchObject({
      status: 'failed',
      delivery_locked_at: null,
    });
    expect(w.broadcast_recipients).toMatchObject([
      {
        status: 'pending',
        error_message: expect.stringContaining('Bad footer'),
      },
      { status: 'pending', error_message: null },
    ]);
    // Not a loop: the next tick has nothing to look at.
    later(60 * MIN);
    expect(await tick()).toMatchObject({ started: 0, skipped: 0 });
  });

  it('a template that could not be read leaves the campaign due', async () => {
    const w = use(world([1], { status: 'scheduled' }), ({ table }) =>
      table === 'message_templates' ? 'down' : null
    );
    await tick();
    await runPasses();
    expect(h.send).not.toHaveBeenCalled();
    expect(w.broadcasts[0]).toMatchObject({
      status: 'scheduled',
      delivery_locked_at: null,
    });
  });
});
