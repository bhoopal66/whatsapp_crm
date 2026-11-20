import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedStatus } from '@/lib/whatsapp/inbound';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { recordHrDelivery } from './delivery';

const AT = '2026-11-20T10:00:00.000Z';
const BOT = [{ sender_type: 'bot' }];

function status(over: Partial<NormalizedStatus> = {}): NormalizedStatus {
  return {
    messageId: 'wamid.1',
    status: 'delivered',
    recipientPhone: '971500000001',
    timestamp: '1758100000',
    ...over,
  };
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: 'recorded', error: null });
});

describe('recordHrDelivery', () => {
  it('skips without an authenticated account', async () => {
    await recordHrDelivery({
      accountId: undefined,
      status: status(),
      at: AT,
      rows: BOT,
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('skips when no resolved row is a bot message', async () => {
    await recordHrDelivery({
      accountId: 'acc',
      status: status(),
      at: AT,
      rows: [{ sender_type: 'agent' }, { sender_type: null }],
    });
    await recordHrDelivery({
      accountId: 'acc',
      status: status(),
      at: AT,
      rows: [],
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('skips a state SQL does not take', async () => {
    await recordHrDelivery({
      accountId: 'acc',
      status: status({ status: 'pending' }),
      at: AT,
      rows: BOT,
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(['sent', 'delivered', 'read'] as const)(
    'passes a %s receipt with no reason',
    async (state) => {
      await recordHrDelivery({
        accountId: 'acc',
        status: status({ status: state }),
        at: AT,
        rows: [{ sender_type: 'agent' }, { sender_type: 'bot' }],
      });
      expect(h.rpc).toHaveBeenCalledWith('hr_automsg_delivery_record', {
        p_account_id: 'acc',
        p_provider_message_id: 'wamid.1',
        p_state: state,
        p_at: AT,
        p_reason: null,
      });
    }
  );

  it("passes a failed receipt's error code as the reason", async () => {
    await recordHrDelivery({
      accountId: 'acc',
      status: status({ status: 'failed', error: { code: 131026, title: 't' } }),
      at: AT,
      rows: BOT,
    });
    expect(h.rpc.mock.calls[0][1]).toMatchObject({
      p_state: 'failed',
      p_reason: '131026',
    });
  });

  it('swallows an rpc error and a throw, logging one line each', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });
    await expect(
      recordHrDelivery({
        accountId: 'acc',
        status: status(),
        at: AT,
        rows: BOT,
      })
    ).resolves.toBeUndefined();
    h.rpc.mockRejectedValueOnce(new Error('down'));
    await expect(
      recordHrDelivery({
        accountId: 'acc',
        status: status(),
        at: AT,
        rows: BOT,
      })
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
