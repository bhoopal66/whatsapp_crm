import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { ForbiddenError } from '@/lib/auth/account';

import {
  isMissingFunction,
  isMissingTable,
  loadMeeting,
  migrationRequiredResponse,
  readAllRows,
  requireMeetingsUser,
  sfuErrorResponse,
} from './server';
import { SfuError } from './sfu';

describe('requireMeetingsUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'bank_guest' });
    await expect(requireMeetingsUser()).rejects.toBeInstanceOf(ForbiddenError);
  });

  // A guest has no current_account_id(), so getCurrentAccount refuses
  // before the role check, in wording that reads as a broken login.
  it('words a guest’s refusal as staff only, keeping other refusals', async () => {
    mocks.getCurrentAccount.mockRejectedValueOnce(
      new ForbiddenError('Profile is not linked to an account')
    );
    await expect(requireMeetingsUser()).rejects.toThrow(
      'Video meetings are for staff only'
    );
    mocks.getCurrentAccount.mockResolvedValueOnce({ role: 'bank_guest' });
    await expect(requireMeetingsUser()).rejects.toThrow(
      'Video meetings are for staff only'
    );
    mocks.getCurrentAccount.mockRejectedValueOnce(
      new ForbiddenError('Account deactivated')
    );
    await expect(requireMeetingsUser()).rejects.toThrow('Account deactivated');
  });

  it('lets every staff role through, viewer included', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'viewer', userId: 'u' });
    await expect(requireMeetingsUser()).resolves.toMatchObject({
      userId: 'u',
    });
  });
});

describe('sfuErrorResponse', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never passes Cloudflare’s own 401 through', async () => {
    const res = sfuErrorResponse(new SfuError('x', 401, 'unauthorized'));
    expect(res?.status).toBe(502);
  });

  it('answers 504 on a timeout and 503 when unconfigured', async () => {
    expect(sfuErrorResponse(new SfuError('x', 504, 'timeout'))?.status).toBe(
      504
    );
    const res = sfuErrorResponse(new SfuError('x', 503, 'not_configured'));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: 'meetings_not_configured' });
  });

  it('answers 410, not 502, when the Cloudflare session is already gone', async () => {
    const res = sfuErrorResponse(new SfuError('x', 410, 'session_error'));
    expect(res?.status).toBe(410);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('leaves anything else to the caller', () => {
    expect(sfuErrorResponse(new Error('x'))).toBeNull();
  });
});

describe('isMissingTable / isMissingFunction', () => {
  it('names each by both its Postgres and its PostgREST code', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true);
    expect(isMissingTable({ code: 'PGRST205' })).toBe(true);
    expect(isMissingFunction({ code: '42883' })).toBe(true);
    expect(isMissingFunction({ code: 'PGRST202' })).toBe(true);
  });

  it('reads nothing else as missing', () => {
    expect(isMissingTable({ code: '42883' })).toBe(false);
    expect(isMissingFunction({ code: '42P01' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});

describe('readAllRows', () => {
  const pages = (
    ...answers: {
      data: number[] | null;
      error?: unknown;
      count?: number | null;
    }[]
  ) => {
    const page = vi.fn(async () => {
      const { data, error = null, count = null } = answers.shift()!;
      return { data, error, count };
    });
    return page;
  };

  it('stops after one query when the count is met', async () => {
    const page = pages({ data: [1, 2], count: 2 });
    expect(await readAllRows(page)).toEqual({ rows: [1, 2], error: null });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledWith(0, 999);
  });

  it('reads on from a short page while the count says there is more', async () => {
    const page = pages({ data: [1, 2], count: 3 }, { data: [3], count: 3 });
    expect((await readAllRows(page)).rows).toEqual([1, 2, 3]);
    expect(page).toHaveBeenLastCalledWith(2, 1001);
  });

  it('stops on an empty page, rows gone or no count', async () => {
    const shrunk = pages({ data: [1], count: 5 }, { data: [], count: 1 });
    expect((await readAllRows(shrunk)).rows).toEqual([1]);
    const uncounted = pages({ data: [1] }, { data: null });
    expect((await readAllRows(uncounted)).rows).toEqual([1]);
  });

  it('gives no partial rows when a page fails', async () => {
    const page = pages(
      { data: [1], count: 2 },
      { data: null, error: { code: '57014' } }
    );
    expect(await readAllRows(page)).toEqual({
      rows: [],
      error: { code: '57014' },
    });
  });
});

describe('migrationRequiredResponse', () => {
  it.each(['42703', 'PGRST204', '42883', 'PGRST202'])(
    'answers 503 for %s',
    async (code) => {
      const res = migrationRequiredResponse({ code });
      expect(res?.status).toBe(503);
      expect(await res?.json()).toEqual({ error: 'migration_required' });
    }
  );

  it('leaves every other failure to the caller', () => {
    expect(migrationRequiredResponse({ code: '23514' })).toBeNull();
    expect(migrationRequiredResponse({})).toBeNull();
    expect(migrationRequiredResponse(null)).toBeNull();
  });
});

describe('loadMeeting', () => {
  // A list naming 176's columns would fail every read before 176.
  it('reads the whole row, so a missing column is only undefined', async () => {
    const select = vi.fn();
    const q = {
      select: (cols: string) => (select(cols), q),
      eq: () => q,
      maybeSingle: async () => ({ data: { id: 'm' }, error: null }),
    };
    const db = { from: () => q } as unknown as Parameters<
      typeof loadMeeting
    >[0];
    const { meeting } = await loadMeeting(db, 'acct-1', 'm');
    expect(select).toHaveBeenCalledWith('*');
    expect(meeting?.locked_at).toBeUndefined();
  });
});
