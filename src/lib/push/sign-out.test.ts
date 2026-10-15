import { describe, expect, it, vi } from 'vitest';

import {
  releasePushOnSignOut,
  signOutReleasingPush,
  type PushSignOutDeps,
} from './sign-out';

function deps(sub: { endpoint: string } | null = { endpoint: 'https://p/1' }) {
  const order: string[] = [];
  const unsubscribe = vi.fn(async () => (order.push('browser'), true));
  const post = vi.fn(async (body: unknown) => {
    order.push(`server:${JSON.stringify(body)}`);
  });
  const d: PushSignOutDeps = {
    getSubscription: async () => (sub ? { ...sub, unsubscribe } : null),
    post,
  };
  return { d, post, unsubscribe, order };
}

describe('releasePushOnSignOut', () => {
  it('forgets this device on the server, then unsubscribes the browser', async () => {
    const f = deps();
    await releasePushOnSignOut({}, f.d);
    expect(f.order).toEqual(['server:{"endpoint":"https://p/1"}', 'browser']);
  });

  it('asks the server to forget every device for sign-out everywhere', async () => {
    const f = deps();
    await releasePushOnSignOut({ all: true }, f.d);
    expect(f.order).toEqual(['server:{"all":true}', 'browser']);
  });

  it('still clears every device when this browser has no subscription', async () => {
    const f = deps(null);
    await releasePushOnSignOut({ all: true }, f.d);
    expect(f.post).toHaveBeenCalledWith({ all: true });
    await releasePushOnSignOut({}, deps(null).d);
  });

  it('unsubscribes the browser even when the server call fails', async () => {
    const f = deps();
    f.post.mockRejectedValueOnce(new Error('offline'));
    await expect(releasePushOnSignOut({}, f.d)).resolves.toBeUndefined();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout instead of holding sign-out', async () => {
    vi.useFakeTimers();
    try {
      const f = deps();
      f.post.mockImplementation(() => new Promise(() => {}));
      const done = vi.fn();
      void releasePushOnSignOut({}, f.d, 2_000).then(done);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('signOutReleasingPush', () => {
  it('releases push before signing out, and returns the sign-out result', async () => {
    const f = deps();
    const signOut = vi.fn(async () => {
      f.order.push('signOut');
      return { error: null };
    });
    expect(await signOutReleasingPush(signOut, { all: true }, f.d)).toEqual({
      error: null,
    });
    expect(f.order).toEqual(['server:{"all":true}', 'browser', 'signOut']);
  });
});
