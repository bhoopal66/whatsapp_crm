import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ process: vi.fn() }));

vi.mock('@/lib/edge', () => ({
  confirmAccepted: vi.fn(),
  releaseAccepted: vi.fn(),
}));
vi.mock('./inbound-events', () => ({ processInboundEvent: h.process }));
vi.mock('./webhook-inbox', () => ({ settleInboundEvent: async () => 'done' }));

import { runDeliveredEvents } from './inbound-delivery';

describe('runDeliveredEvents', () => {
  it('hands the attempt over, so a redelivery after a failure is a retry', async () => {
    h.process.mockResolvedValue({ outcome: 'done' });
    const config = { id: 'ch-1' };
    const recorded = [1, 2].map((attempt) => ({
      event: { config, decision: {} },
      id: `row-${attempt}`,
      attempt,
      state: 'claimed',
    }));
    await runDeliveredEvents(
      {} as never,
      recorded as unknown as Parameters<typeof runDeliveredEvents>[1],
      []
    );
    expect(h.process.mock.calls.map((c) => c[1])).toEqual([
      { config, later: [], attempt: 1 },
      { config, later: [], attempt: 2 },
    ]);
  });
});
