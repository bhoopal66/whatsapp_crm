import { describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({
  submissionGroupStore: vi.fn(),
  submissionGroupService: vi.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { runSubmissionGroupsCron } from './cron';
import type { SubmissionGroup } from './store';

const g = (id: string, accountId: string) =>
  ({ id, accountId }) as SubmissionGroup;
const admin = {} as SupabaseClient;

function fakes(o: {
  pending?: SubmissionGroup[];
  unclosed?: SubmissionGroup[];
}) {
  const store = {
    listPendingCreates: vi.fn().mockResolvedValue(o.pending ?? []),
    listUnclosedEnded: vi.fn().mockResolvedValue(o.unclosed ?? []),
    failStalePending: vi.fn().mockResolvedValue(['9']),
  };
  const services = new Map<
    string,
    {
      retryPending: ReturnType<typeof vi.fn>;
      retryClose: ReturnType<typeof vi.fn>;
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
    };
    services.set(accountId, svc);
    return svc;
  };
  return { store, services, serviceFor };
}

describe('runSubmissionGroupsCron', () => {
  it('sweeps once, then retries pending creates and closes per account with that account only', async () => {
    const f = fakes({
      pending: [g('p1', 'A'), g('p2', 'A')],
      unclosed: [g('e1', 'B'), g('e2', 'A')],
    });
    const r = await runSubmissionGroupsCron(admin, f);
    expect(f.store.failStalePending).toHaveBeenCalledTimes(1);
    expect(f.store.failStalePending).toHaveBeenCalledWith(600_000);
    expect(f.services.get('A')!.retryPending).toHaveBeenCalledWith({
      accountId: 'A',
      olderThanMs: 120_000,
    });
    expect(f.services.get('A')!.retryPending).toHaveBeenCalledTimes(1);
    expect(f.services.get('B')!.retryPending).not.toHaveBeenCalled();
    expect(f.services.get('A')!.retryClose).toHaveBeenCalledWith('e2');
    expect(f.services.get('B')!.retryClose).toHaveBeenCalledWith('e1');
    expect(r).toEqual({
      stalePendingFailed: 1,
      accounts: 2,
      created: 1,
      createFailed: 0,
      closed: 2,
      closeFailed: 0,
      errors: [],
    });
  });

  it('never throws: a failing account or listing is reported and the rest still run', async () => {
    const f = fakes({ unclosed: [g('e1', 'A'), g('e2', 'B')] });
    f.store.failStalePending.mockRejectedValue(new Error('db down'));
    const serviceFor = (id: string) => {
      const svc = f.serviceFor(id);
      if (id === 'A') svc.retryClose.mockRejectedValue(new Error('boom'));
      return svc;
    };
    const r = await runSubmissionGroupsCron(admin, { ...f, serviceFor });
    expect(r).toMatchObject({ closed: 1, closeFailed: 1 });
    expect(r.errors).toEqual(['sweep: db down', 'e1: boom']);

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
