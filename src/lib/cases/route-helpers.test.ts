import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';

const access = vi.hoisted(() => ({ writer: null as null | boolean }));
// Every case role writes today (122), so a non-writer is simulated.
vi.mock('./access', async (importOriginal) => {
  const real = await importOriginal<typeof import('./access')>();
  return {
    ...real,
    canWriteCase: (r: Parameters<typeof real.canWriteCase>[0]) =>
      access.writer ?? real.canWriteCase(r),
  };
});

import { BankDashboardRefusedError } from './dashboard';
import {
  CaseHttpError,
  caseErrorResponse,
  loadCaseForCaller,
  optionalFileRef,
  requiredKey,
  requiredText,
} from './route-helpers';
import { CaseRefusedError, CaseStoreError } from './store';

const C = '11111111-1111-4111-8111-111111111111';
const ctx = { accountId: 'acct-1', userId: 'u-1' };

function store(accountId = 'acct-1', role: string | null = 'agent') {
  return {
    get: vi.fn().mockResolvedValue({ id: C, accountId }),
    role: vi.fn().mockResolvedValue(role),
  };
}

async function statusOf(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (err) {
    return err instanceof CaseHttpError ? err.status : -1;
  }
}

beforeEach(() => {
  access.writer = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadCaseForCaller', () => {
  it('returns the case and role for a writer', async () => {
    const s = store();
    const out = await loadCaseForCaller(s, ctx, C, { write: true });
    expect(out.role).toBe('agent');
    expect(s.role).toHaveBeenCalledWith(C, 'u-1');
  });

  it("is 404 for another account's case even when the store returns it", async () => {
    const s = store('acct-2', 'admin');
    expect(await statusOf(loadCaseForCaller(s, ctx, C, { write: false }))).toBe(
      404
    );
    expect(s.role).not.toHaveBeenCalled();
  });

  it('is 404 for a missing case, a non-uuid id, or no role', async () => {
    const missing = store();
    missing.get.mockResolvedValue(null);
    expect(
      await statusOf(loadCaseForCaller(missing, ctx, C, { write: false }))
    ).toBe(404);
    const s = store();
    expect(
      await statusOf(loadCaseForCaller(s, ctx, 'nope', { write: false }))
    ).toBe(404);
    expect(s.get).not.toHaveBeenCalled();
    expect(
      await statusOf(
        loadCaseForCaller(store('acct-1', null), ctx, C, { write: false })
      )
    ).toBe(404);
  });

  it('is 403 for a write by a role that may not write, 200 for its read', async () => {
    access.writer = false;
    expect(
      await statusOf(loadCaseForCaller(store(), ctx, C, { write: true }))
    ).toBe(403);
    expect(
      await statusOf(loadCaseForCaller(store(), ctx, C, { write: false }))
    ).toBe(200);
  });

  it('treats a role outside the case roles as none (404)', async () => {
    const s = store('acct-1', 'viewer');
    expect(await statusOf(loadCaseForCaller(s, ctx, C, { write: true }))).toBe(
      404
    );
  });
});

describe('caseErrorResponse', () => {
  it.each([
    [new CaseRefusedError('NOT_ALLOWED'), 403, undefined],
    [new CaseRefusedError('CASE_NOT_FOUND'), 404, undefined],
    [new CaseRefusedError('TASK_NOT_FOUND'), 404, undefined],
    [new CaseRefusedError('NOTE_TOO_LONG'), 422, 'NOTE_TOO_LONG'],
    [
      new BankDashboardRefusedError('REASON_ALREADY_SET'),
      422,
      'REASON_ALREADY_SET',
    ],
    [new BankDashboardRefusedError('NOT_ALLOWED'), 403, undefined],
  ])('maps %s', async (err, status, code) => {
    const res = caseErrorResponse(err, 't');
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it('keeps auth errors', () => {
    expect(caseErrorResponse(new ForbiddenError(), 't').status).toBe(403);
  });

  it('answers a generic 500 and never logs the message', async () => {
    for (const err of [
      new CaseStoreError('case_note_add', '23514'),
      new Error('secret note text'),
    ]) {
      const res = caseErrorResponse(err, 't');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Something went wrong' });
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });
});

describe('parsers', () => {
  it('checks text, keys and file refs', () => {
    expect(requiredText('  hi ', 'body', 5)).toBe('hi');
    expect(() => requiredText('   ', 'body', 5)).toThrow(CaseHttpError);
    expect(() => requiredText('toolong', 'body', 5)).toThrow(CaseHttpError);
    expect(requiredKey('id_card', 'k')).toBe('id_card');
    expect(() => requiredKey('ID Card', 'k')).toThrow(CaseHttpError);
    expect(optionalFileRef(undefined)).toBeNull();
    expect(optionalFileRef('files:abc-1.pdf')).toBe('files:abc-1.pdf');
    expect(() => optionalFileRef('.hidden')).toThrow(CaseHttpError);
    expect(() => optionalFileRef('a/b')).toThrow(CaseHttpError);
  });
});
