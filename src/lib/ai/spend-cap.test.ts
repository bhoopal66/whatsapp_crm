import { describe, expect, it, vi } from 'vitest';
import {
  refundAiSpend,
  reserveAiSpend,
  type SpendRpcClient,
} from './spend-cap';

const NOW = () => new Date('2026-11-28T15:00:00Z');

function client(
  answers: Record<string, () => { data: unknown; error: unknown }>
) {
  const rpc = vi.fn(async (fn: string) => {
    const a = answers[fn];
    if (!a) throw new Error(`unexpected rpc ${fn}`);
    return a();
  });
  return { c: { rpc } as SpendRpcClient, rpc };
}

const cap = (micros: number | null) => () => ({
  data: [{ daily_marketing_spend_micros: null, daily_ai_spend_micros: micros }],
  error: null,
});

describe('reserveAiSpend', () => {
  it('no cap: allowed without touching the ledger', async () => {
    const { c, rpc } = client({ send_protection_caps_get: cap(null) });
    const d = await reserveAiSpend(c, 'acc', 500, NOW);
    expect(d).toEqual({ allowed: true, reservation: null });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('cap set: reserves through spend_add with the cap', async () => {
    const { c, rpc } = client({
      send_protection_caps_get: cap(1000),
      send_protection_spend_add: () => ({
        data: [{ allowed: true, total_micros: 500 }],
        error: null,
      }),
    });
    const d = await reserveAiSpend(c, 'acc', 500, NOW);
    expect(d).toEqual({
      allowed: true,
      totalMicros: 500,
      reservation: { accountId: 'acc', day: '2026-11-28', micros: 500 },
    });
    expect(rpc).toHaveBeenLastCalledWith('send_protection_spend_add', {
      p_account: 'acc',
      p_scope: 'ai.daily',
      p_micros: 500,
      p_hard_cap: 1000,
    });
  });

  it('cap reached: denied, nothing held', async () => {
    const { c } = client({
      send_protection_caps_get: cap(1000),
      send_protection_spend_add: () => ({
        data: [{ allowed: false, total_micros: 900 }],
        error: null,
      }),
    });
    const d = await reserveAiSpend(c, 'acc', 500, NOW);
    expect(d).toEqual({ allowed: false, totalMicros: 900, reservation: null });
  });

  it('cap set and the ledger fails: fails closed', async () => {
    for (const fail of [
      () => ({ data: null, error: { message: 'down' } }),
      () => {
        throw new Error('network');
      },
    ]) {
      const { c } = client({
        send_protection_caps_get: cap(1000),
        send_protection_spend_add: fail,
      });
      const d = await reserveAiSpend(c, 'acc', 500, NOW);
      expect(d).toEqual({ allowed: false, degraded: true, reservation: null });
    }
  });

  it('the cap cannot be read: fails closed', async () => {
    const { c } = client({
      send_protection_caps_get: () => ({ data: null, error: { message: 'x' } }),
    });
    expect((await reserveAiSpend(c, 'acc', 1, NOW)).allowed).toBe(false);
  });
});

describe('refundAiSpend', () => {
  it('refunds the reservation on its own day', async () => {
    const { c, rpc } = client({
      send_protection_spend_refund: () => ({ data: 0, error: null }),
    });
    const ok = await refundAiSpend(c, {
      accountId: 'acc',
      day: '2026-11-27',
      micros: 500,
    });
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('send_protection_spend_refund', {
      p_account: 'acc',
      p_scope: 'ai.daily',
      p_day: '2026-11-27',
      p_micros: 500,
    });
  });

  it('nothing held: no call', async () => {
    const { c, rpc } = client({});
    expect(await refundAiSpend(c, null)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a failing store never throws', async () => {
    const { c } = client({
      send_protection_spend_refund: () => {
        throw new Error('down');
      },
    });
    expect(
      await refundAiSpend(c, { accountId: 'a', day: '2026-11-28', micros: 1 })
    ).toBe(false);
  });
});
