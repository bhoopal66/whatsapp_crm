import { describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({
  submissionGroupStore: vi.fn(),
  submissionGroupService: vi.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseStoreError } from '@/lib/cases/store';

import { INCOMPLETE_RETRY_MS, runSubmissionGroupsCron } from './cron';
import type { SubmissionGroup } from './store';
import { closeRemainingText } from './wa-errors';

const g = (id: string, accountId: string, over: object = {}) =>
  ({ id, accountId, ...over }) as SubmissionGroup;
const admin = {} as SupabaseClient;

function fakes(o: {
  pending?: SubmissionGroup[];
  unclosed?: SubmissionGroup[];
}) {
  const store = {
    listWithoutCase: vi.fn().mockResolvedValue([]),
    listPendingCreates: vi.fn().mockResolvedValue(o.pending ?? []),
    listUnclosedEnded: vi.fn().mockResolvedValue(o.unclosed ?? []),
    failStalePending: vi.fn().mockResolvedValue(['9']),
    sweepAddNumbers: vi.fn().mockResolvedValue(2),
    membershipAccounts: vi.fn().mockResolvedValue([]),
    membershipDue: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    contactConsent: vi.fn(),
    noteCustomerMembership: vi.fn(),
  };
  const services = new Map<
    string,
    {
      retryPending: ReturnType<typeof vi.fn>;
      retryClose: ReturnType<typeof vi.fn>;
      sendWelcomeIfDue: ReturnType<typeof vi.fn>;
    }
  >();
  const serviceFor = (accountId: string) => {
    const svc = {
      retryPending: vi.fn().mockResolvedValue({
        attempted: 1,
        created: ['x'],
        consentRequired: [],
        failed: [],
      }),
      retryClose: vi.fn().mockResolvedValue({ closed: true }),
      sendWelcomeIfDue: vi.fn().mockResolvedValue(null),
    };
    services.set(accountId, svc);
    return svc;
  };
  return { store, services, serviceFor };
}

describe('runSubmissionGroupsCron', () => {
  it('tries a group somebody cannot be taken out of once in 30 minutes', async () => {
    const stuck = g('stuck-1', 'A', {
      waCloseError: closeRemainingText(1),
    });
    const other = g('other-1', 'A', { waCloseError: 'gateway error' });
    const start = 1_800_000_000_000;
    const tries = async (at: number) => {
      const f = fakes({ unclosed: [stuck, other] });
      await runSubmissionGroupsCron(admin, {
        store: f.store as never,
        serviceFor: f.serviceFor as never,
        now: () => at,
      });
      return f.services
        .get('A')!
        .retryClose.mock.calls.map((c) => c[0])
        .sort();
    };
    expect(await tries(start)).toEqual(['other-1', 'stuck-1']);
    expect(await tries(start + 60_000)).toEqual(['other-1']);
    expect(await tries(start + INCOMPLETE_RETRY_MS)).toEqual([
      'other-1',
      'stuck-1',
    ]);
  });

  it('sends the welcome message for each group the pass created', async () => {
    const f = fakes({ pending: [g('p1', 'A')] });
    await runSubmissionGroupsCron(admin, f);
    expect(f.services.get('A')!.sendWelcomeIfDue).toHaveBeenCalledTimes(1);
    expect(f.services.get('A')!.sendWelcomeIfDue).toHaveBeenCalledWith('x');
  });

  it('sweeps once, then retries pending creates and closes per account with that account only', async () => {
    const f = fakes({
      pending: [g('p1', 'A'), g('p2', 'A')],
      unclosed: [g('e1', 'B'), g('e2', 'A')],
    });
    const r = await runSubmissionGroupsCron(admin, f);
    expect(f.store.failStalePending).toHaveBeenCalledTimes(1);
    expect(f.store.failStalePending).toHaveBeenCalledWith(600_000);
    // 211: add-number attempts nobody settled, after 10 minutes.
    expect(f.store.sweepAddNumbers).toHaveBeenCalledWith(600);
    expect(f.services.get('A')!.retryPending).toHaveBeenCalledWith({
      accountId: 'A',
      olderThanMs: 120_000,
      spent: expect.any(Function),
      failedChannels: new Set(),
    });
    expect(f.services.get('A')!.retryPending).toHaveBeenCalledTimes(1);
    expect(f.services.get('B')!.retryPending).not.toHaveBeenCalled();
    expect(f.services.get('A')!.retryClose).toHaveBeenCalledWith('e2');
    expect(f.services.get('B')!.retryClose).toHaveBeenCalledWith('e1');
    expect(r).toEqual({
      stalePendingFailed: 1,
      staleAddsFailed: 2,
      casesOpened: 0,
      accounts: 2,
      membershipChecked: 0,
      created: 1,
      createFailed: 0,
      closed: 2,
      closeFailed: 0,
      errors: [],
    });
  });

  it('opens the case of each group that has none, one failure apart, before the creates', async () => {
    const f = fakes({ pending: [g('p1', 'A')] });
    f.store.listWithoutCase.mockResolvedValue([
      { id: 'n1', accountId: 'A' },
      { id: 'n2', accountId: 'B' },
    ]);
    const order: string[] = [];
    const openCase = vi.fn(async (accountId: string, id: string) => {
      order.push(`open ${accountId} ${id}`);
      if (id === 'n1') throw new CaseStoreError('case_open', '57014');
    });
    const serviceFor = (id: string) => {
      order.push(`service ${id}`);
      return f.serviceFor(id);
    };
    const r = await runSubmissionGroupsCron(admin, {
      ...f,
      serviceFor,
      openCase,
      now: () => 1_000_000,
    });
    // A younger group is left to its own POST.
    expect(f.store.listWithoutCase).toHaveBeenCalledWith(
      new Date(1_000_000 - 120_000),
      { limit: 20 }
    );
    expect(order).toEqual(['open A n1', 'open B n2', 'service A']);
    expect(r.casesOpened).toBe(1);
    expect(r.errors).toEqual(['n1: case: cases: case_open failed (57014)']);
  });

  it('an unreadable list of groups without a case delays no create', async () => {
    const f = fakes({ pending: [g('p1', 'A')] });
    f.store.listWithoutCase.mockRejectedValue(new Error('db down'));
    const r = await runSubmissionGroupsCron(admin, f);
    expect(r.created).toBe(1);
    expect(r.errors).toEqual(['cases: db down']);
  });

  it('after one failure on a number, skips its other closes and its membership reads', async () => {
    const f = fakes({
      unclosed: [
        g('e1', 'A', { channelId: 'bad' }),
        g('e2', 'A', { channelId: 'bad' }),
        g('e3', 'A', { channelId: 'good' }),
      ],
    });
    f.store.membershipAccounts.mockResolvedValue(['A']);
    f.store.membershipDue.mockResolvedValue(['m1']);
    f.store.get.mockResolvedValue(g('m1', 'A', { channelId: 'bad' }));
    const serviceFor = (id: string) => {
      const svc = f.serviceFor(id);
      svc.retryClose.mockImplementation(async (groupId: string) =>
        groupId === 'e1'
          ? { closed: false, closeError: 'timed out', numberDown: true }
          : { closed: true }
      );
      return svc;
    };
    const getParticipants = vi.fn();
    const r = await runSubmissionGroupsCron(admin, {
      ...f,
      serviceFor,
      participantsFor: () => ({ getParticipants }),
    });
    expect(f.services.get('A')!.retryClose.mock.calls).toEqual([
      ['e1'],
      ['e3'],
    ]);
    expect(r).toMatchObject({ closed: 1, closeFailed: 1 });
    expect(getParticipants).not.toHaveBeenCalled();
  });

  it('a create that found the number failing keeps its closes out of the run', async () => {
    const f = fakes({
      pending: [g('p1', 'A')],
      unclosed: [g('e1', 'A', { channelId: 'bad' })],
    });
    const serviceFor = (id: string) => {
      const svc = f.serviceFor(id);
      svc.retryPending.mockImplementation(
        async (input: { failedChannels: Set<string> }) => {
          input.failedChannels.add('bad');
          return { attempted: 1, created: [], consentRequired: [], failed: [] };
        }
      );
      return svc;
    };
    await runSubmissionGroupsCron(admin, { ...f, serviceFor });
    expect(f.services.get('A')!.retryClose).not.toHaveBeenCalled();
  });

  it('a close that failed before goes after the ones that did not', async () => {
    const f = fakes({
      unclosed: [g('e1', 'A', { waCloseError: 'boom' }), g('e2', 'A')],
    });
    await runSubmissionGroupsCron(admin, f);
    expect(f.services.get('A')!.retryClose.mock.calls).toEqual([
      ['e2'],
      ['e1'],
    ]);
  });

  it('never throws: a failing account or listing is reported and the rest still run', async () => {
    const f = fakes({ unclosed: [g('e1', 'A'), g('e2', 'B')] });
    f.store.failStalePending.mockRejectedValue(new Error('db down'));
    f.store.sweepAddNumbers.mockRejectedValue(new Error('no 211'));
    const serviceFor = (id: string) => {
      const svc = f.serviceFor(id);
      if (id === 'A') svc.retryClose.mockRejectedValue(new Error('boom'));
      return svc;
    };
    const r = await runSubmissionGroupsCron(admin, { ...f, serviceFor });
    expect(r).toMatchObject({ closed: 1, closeFailed: 1 });
    expect(r.errors).toEqual([
      'sweep: db down',
      'add sweep: no 211',
      'e1: boom',
    ]);

    const broken = fakes({});
    broken.store.listPendingCreates.mockRejectedValue(new Error('gone'));
    await expect(runSubmissionGroupsCron(admin, broken)).resolves.toMatchObject(
      { errors: ['gone'] }
    );
  });

  it('starts no new account after the time budget', async () => {
    const f = fakes({ unclosed: [g('e1', 'A'), g('e2', 'B')] });
    let t = 0;
    const now = () => t;
    const serviceFor = (id: string) => {
      const svc = f.serviceFor(id);
      svc.retryClose.mockImplementation(async () => {
        t += 46_000;
        return { closed: true };
      });
      return svc;
    };
    const r = await runSubmissionGroupsCron(admin, { ...f, serviceFor, now });
    expect(r.accounts).toBe(1);
    expect(f.services.has('B')).toBe(false);
  });
});
