import { afterEach, describe, expect, it, vi } from 'vitest';

import { outboundCallsEnabled } from '../outbound';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('outboundCallsEnabled', () => {
  it('is on only for exactly `on`', () => {
    vi.stubEnv('NEXT_PUBLIC_PBX_OUTBOUND_CALLS', 'on');
    expect(outboundCallsEnabled()).toBe(true);
  });

  it('is off when unset, empty or anything else', () => {
    for (const v of [undefined, '', 'off', 'ON', 'true', '1', ' on']) {
      vi.stubEnv('NEXT_PUBLIC_PBX_OUTBOUND_CALLS', v);
      expect(outboundCallsEnabled()).toBe(false);
    }
  });
});
