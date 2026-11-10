import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({ caseMacroStore: () => m.store }));

import { CaseRefusedError } from '@/lib/cases/store';
import { DELETE } from './[id]/route';
import { GET, POST } from './route';

const MID = '22222222-2222-4222-8222-222222222222';
const macro = { id: MID, name: 'Chase', actions: [], shared: false };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-me', accountId: 'a-1' });
  m.store = {
    list: vi.fn(async () => [macro]),
    save: vi.fn(async () => macro),
    delete: vi.fn(async () => undefined),
  };
});

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/cases/macros', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
const del = (id: string) =>
  DELETE(new Request(`http://x/api/cases/macros/${id}`), {
    params: Promise.resolve({ id }),
  });

describe('/api/cases/macros', () => {
  it('GET lists the caller’s macros', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ macros: [macro] });
    expect(m.store.list).toHaveBeenCalledWith('u-me');
  });

  it('POST saves and answers { macro }', async () => {
    const actions = [{ kind: 'request_documents' }];
    const res = await post({
      macroId: MID,
      name: 'Chase',
      actions,
      shared: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ macro });
    expect(m.store.save).toHaveBeenCalledWith('u-me', {
      macroId: MID,
      name: 'Chase',
      actions,
      shared: true,
    });
  });

  it.each([
    ['ACTION_INVALID', 422],
    ['NAME_INVALID', 422],
    ['NOT_ALLOWED', 403],
    ['MACRO_NOT_FOUND', 404],
  ] as const)('POST maps %s to %i with its code', async (code, status) => {
    m.store.save.mockRejectedValue(new CaseRefusedError(code));
    const res = await post({ name: 'x', actions: [] });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it('POST refuses a bad macroId (404) and a non-boolean shared (400) before saving', async () => {
    expect(
      (await post({ macroId: 'nope', name: 'x', actions: [] })).status
    ).toBe(404);
    expect((await post({ name: 'x', actions: [], shared: 'yes' })).status).toBe(
      400
    );
    expect(m.store.save).not.toHaveBeenCalled();
  });

  it('DELETE answers { deleted: true }; MACRO_NOT_FOUND is 404', async () => {
    const ok = await del(MID);
    expect(await ok.json()).toEqual({ deleted: true });
    expect(m.store.delete).toHaveBeenCalledWith('u-me', MID);
    m.store.delete.mockRejectedValue(new CaseRefusedError('MACRO_NOT_FOUND'));
    expect((await del(MID)).status).toBe(404);
    expect((await del('bad')).status).toBe(404);
  });
});
