import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  reviewStuck: vi.fn(),
  expire: vi.fn(),
  due: vi.fn(),
  enqueueNudges: vi.fn(),
  processDue: vi.fn(),
  sendPort: { send: vi.fn() },
  admin: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: h.admin,
}));
vi.mock('./store', () => ({
  PgAutoMsgStore: class {
    reviewStuck = h.reviewStuck;
    expire = h.expire;
    due = h.due;
    enqueueNudges = h.enqueueNudges;
  },
}));
vi.mock('./send', () => ({ createHrSendPort: () => h.sendPort }));
vi.mock('./engine', () => ({ processDue: h.processDue }));

import { runHrAutomsgDrain, runHrAutomsgNudges } from './drain';

const NOW = new Date('2026-11-16T10:00:00Z');

beforeEach(() => {
  h.calls.length = 0;
  h.admin.mockReset().mockReturnValue({ db: true });
  h.reviewStuck.mockReset().mockImplementation(async () => {
    h.calls.push('review');
    return 2;
  });
  h.expire.mockReset().mockImplementation(async () => {
    h.calls.push('expire');
    return 3;
  });
  h.due.mockReset().mockImplementation(async () => {
    h.calls.push('due');
    return [{ id: 'r1' }];
  });
  h.processDue.mockReset().mockImplementation(async () => {
    h.calls.push('process');
    return { sent: 1, held: 2 };
  });
  h.enqueueNudges.mockReset().mockResolvedValue(4);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runHrAutomsgDrain', () => {
  it('reviews, expires, reads due, then processes, and sums up', async () => {
    const out = await runHrAutomsgDrain({ now: NOW });
    expect(h.calls).toEqual(['review', 'expire', 'due', 'process']);
    expect(out).toEqual({
      reviewed: 2,
      expired: 3,
      outcomes: { sent: 1, held: 2 },
    });
    expect(h.reviewStuck).toHaveBeenCalledWith(NOW);
    expect(h.expire).toHaveBeenCalledWith(NOW);
    const [rows, deps] = h.processDue.mock.calls[0];
    expect(rows).toEqual([{ id: 'r1' }]);
    expect(deps.sender).toBe(h.sendPort);
    expect(deps.clock.now()).toEqual(NOW);
  });

  it('defaults the limit to 100 and passes limit and accountId through', async () => {
    await runHrAutomsgDrain();
    expect(h.due).toHaveBeenLastCalledWith(100, undefined);
    await runHrAutomsgDrain({ limit: 5, accountId: 'acc-1' });
    expect(h.due).toHaveBeenLastCalledWith(5, 'acc-1');
  });

  it.each(['reviewStuck', 'expire', 'due', 'processDue'] as const)(
    'returns null and logs once when %s throws',
    async (step) => {
      h[step].mockRejectedValue(new Error('boom'));
      await expect(runHrAutomsgDrain({ now: NOW })).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        '[hr-automsg] drain failed:',
        'boom'
      );
    }
  );

  it('returns null when the client cannot be built', async () => {
    h.admin.mockImplementation(() => {
      throw new Error('no env');
    });
    await expect(runHrAutomsgDrain()).resolves.toBeNull();
    expect(h.reviewStuck).not.toHaveBeenCalled();
  });
});

describe('runHrAutomsgNudges', () => {
  it('returns the number of nudges enqueued', async () => {
    await expect(runHrAutomsgNudges(NOW)).resolves.toBe(4);
    expect(h.enqueueNudges).toHaveBeenCalledWith(NOW);
  });

  it('returns null on failure without throwing', async () => {
    h.enqueueNudges.mockRejectedValue(new Error('boom'));
    await expect(runHrAutomsgNudges(NOW)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      '[hr-automsg] nudges failed:',
      'boom'
    );
  });
});

describe('runHrAutomsgDrain: RCS sender', () => {
  it('is null without RCS settings', async () => {
    vi.stubEnv('RCS_BASE_URL', '');
    vi.stubEnv('RCS_TOKEN', '');
    vi.stubEnv('RCS_SENDER_ID', '');
    await runHrAutomsgDrain({ now: NOW });
    expect(h.processDue.mock.calls[0][1].senders).toEqual({ rcs: null });
    vi.unstubAllEnvs();
  });

  it('is built when all three settings are present', async () => {
    vi.stubEnv('RCS_BASE_URL', 'https://rcs.example');
    vi.stubEnv('RCS_TOKEN', 't');
    vi.stubEnv('RCS_SENDER_ID', 's');
    await runHrAutomsgDrain({ now: NOW });
    const rcs = h.processDue.mock.calls[0][1].senders.rcs;
    expect(typeof rcs?.send).toBe('function');
    vi.unstubAllEnvs();
  });
});
