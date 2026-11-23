import { describe, expect, it, vi } from 'vitest';

import { releaseOnSessionChange, repairPush, type RepairDeps } from './repair';

function deps(over: Partial<RepairDeps> = {}) {
  return {
    enabledBy: () => 'me' as string | null,
    setEnabledBy: vi.fn(),
    granted: true,
    subscription: async () => ({ endpoint: 'e1' }),
    ownsRow: vi.fn(async () => false),
    register: vi.fn(async () => 201),
    resubscribe: vi.fn(async () => 201),
    unsubscribe: vi.fn(async () => true),
    ...over,
  };
}

describe('repairPush', () => {
  it('re-registers the device of the person who turned it on here', async () => {
    const d = deps();
    expect(await repairPush('me', d)).toBe('kept');
    expect(d.register).toHaveBeenCalledTimes(1);
    expect(d.unsubscribe).not.toHaveBeenCalled();
  });

  it.each(['someone-else', null])(
    'unsubscribes a device recorded for %s, never registering it',
    async (by) => {
      const d = deps({ enabledBy: () => by });
      expect(await repairPush('me', d)).toBe('released');
      expect(d.unsubscribe).toHaveBeenCalledTimes(1);
      expect(d.register).not.toHaveBeenCalled();
    }
  );

  it('keeps, and marks, a device turned on before the marker existed', async () => {
    const d = deps({ enabledBy: () => null, ownsRow: async () => true });
    expect(await repairPush('me', d)).toBe('kept');
    expect(d.setEnabledBy).toHaveBeenCalledWith('me');
    expect(d.unsubscribe).not.toHaveBeenCalled();
  });

  it('changes nothing when the server cannot be asked', async () => {
    const unknown = deps({
      enabledBy: () => null,
      ownsRow: async () => Promise.reject(new Error('offline')),
    });
    expect(await repairPush('me', unknown)).toBe('failed');
    expect(unknown.unsubscribe).not.toHaveBeenCalled();
    for (const status of [401, 429, 500, 503]) {
      const d = deps({ register: async () => status });
      expect(await repairPush('me', d)).toBe('failed');
      expect(d.unsubscribe).not.toHaveBeenCalled();
    }
  });

  it('subscribes again only for its own person and with permission', async () => {
    const lost = { subscription: async () => null };
    const d = deps(lost);
    expect(await repairPush('me', d)).toBe('kept');
    expect(d.resubscribe).toHaveBeenCalledTimes(1);
    for (const over of [
      { granted: false },
      { enabledBy: () => 'someone-else' },
      { enabledBy: () => null },
    ]) {
      const other = deps({ ...lost, ...over });
      expect(await repairPush('me', other)).toBe('none');
      expect(other.resubscribe).not.toHaveBeenCalled();
    }
  });

  it('drops a subscription the server holds for someone else with other keys', async () => {
    const d = deps({ register: async () => 409 });
    expect(await repairPush('me', d)).toBe('released');
    expect(d.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('releaseOnSessionChange', () => {
  it('on session loss and for another person, not for the device’s own', () => {
    expect(releaseOnSessionChange('a', null)).toBe(true);
    expect(releaseOnSessionChange(null, null)).toBe(true);
    expect(releaseOnSessionChange('a', 'b')).toBe(true);
    expect(releaseOnSessionChange('b', 'b')).toBe(false);
    expect(releaseOnSessionChange(null, 'b')).toBe(false);
  });
});
