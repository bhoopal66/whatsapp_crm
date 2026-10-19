import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  pins: vi.fn(),
  setPin: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list, pins: m.pins, setPin: m.setPin }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { GET, PUT } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const params = () => ({ params: Promise.resolve({ id: WS }) });
const get = (q = '') => GET(new Request(`http://x/${q}`), params());
const put = (body: unknown) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params()
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.pins.mockResolvedValue([{ pinId: 'pin-1' }]);
  m.setPin.mockResolvedValue('pin-2');
});

describe('pins', () => {
  it('lists the current pins, or every version with ?history=1', async () => {
    expect(await (await get()).json()).toEqual({ pins: [{ pinId: 'pin-1' }] });
    expect(m.pins).toHaveBeenLastCalledWith(WS, 'u-1', { history: false });
    await get('?history=1');
    expect(m.pins).toHaveBeenLastCalledWith(WS, 'u-1', { history: true });
  });

  it('sets a trimmed pin, and a blank body clears it', async () => {
    const res = await put({ kind: 'product_rules', body: ' min salary 5k ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinId: 'pin-2' });
    expect(m.setPin).toHaveBeenLastCalledWith(
      WS,
      'u-1',
      'product_rules',
      'min salary 5k'
    );
    expect((await put({ kind: 'product_rules', body: '  ' })).status).toBe(200);
    expect(m.setPin).toHaveBeenLastCalledWith(WS, 'u-1', 'product_rules', '');
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await put({ kind: 'product_rules', body: 'x' })).status).toBe(404);
    expect((await get()).status).toBe(404);
    expect(m.setPin).not.toHaveBeenCalled();
    expect(m.pins).not.toHaveBeenCalled();
  });

  it('answers 400 over the cap or without a body, 422 for an unknown kind', async () => {
    expect(
      (await put({ kind: 'product_rules', body: 'x'.repeat(8001) })).status
    ).toBe(400);
    expect((await put({ kind: 'product_rules' })).status).toBe(400);
    const res = await put({ kind: 'gossip', body: 'x' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('KIND_INVALID');
    expect(m.setPin).not.toHaveBeenCalled();
    expect(
      (await put({ kind: 'product_rules', body: 'x'.repeat(8000) })).status
    ).toBe(200);
  });

  it('maps NOT_ALLOWED to 403', async () => {
    m.setPin.mockRejectedValue(new BankWorkspaceRefusedError('NOT_ALLOWED'));
    expect((await put({ kind: 'product_rules', body: 'x' })).status).toBe(403);
  });
});
