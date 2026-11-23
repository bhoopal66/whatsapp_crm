'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  deviceState,
  pushSupport,
  readPushEnv,
  toPushPermission,
  urlBase64ToUint8Array,
  type PushDeviceState,
  type PushPermission,
  type PushSupport,
} from '@/lib/push/client';
import { useAuth } from '@/hooks/use-auth';
import {
  readPushEnabledBy,
  repairPush,
  writePushEnabledBy,
} from '@/lib/push/repair';
import { pendingPushRelease } from '@/lib/push/sign-out';
import type { PushTestOutcome } from '@/lib/push/test-outcome';
import { createClient } from '@/lib/supabase/client';

/**
 * This device's web push subscription: registers /sw.js (once per page
 * load), reads the browser's permission and subscription, and turns
 * push on or off against /api/push/{config,subscribe,unsubscribe}.
 */

// One registration per page load, shared by every mounted consumer
// (the dashboard banner and the settings panel).
let registration: Promise<ServiceWorkerRegistration> | null = null;

function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!registration) {
    registration = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        registration = null;
        throw err;
      });
  }
  return registration;
}

function currentSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  return pushSupport(readPushEnv(navigator, window));
}

function currentPermission(): PushPermission {
  try {
    return toPushPermission(window.Notification?.permission);
  } catch {
    return 'default';
  }
}

async function postSubscription(sub: PushSubscription): Promise<number> {
  const json = sub.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      userAgent: navigator.userAgent,
    }),
  });
  return res.status;
}

async function fetchPublicKey(): Promise<string | null> {
  const res = await fetch('/api/push/config');
  const body = res.ok
    ? ((await res.json()) as { publicKey?: string | null })
    : null;
  return body?.publicKey ?? null;
}

// The repair runs once per page load and person, shared by every mounted
// consumer. One that failed (offline) runs again on the next mount.
let repair: { userId: string; done: Promise<void> } | null = null;

function repairOnce(
  userId: string,
  reg: ServiceWorkerRegistration
): Promise<void> {
  if (repair?.userId === userId) return repair.done;
  const mine = { userId, done: Promise.resolve() };
  repair = mine;
  mine.done = (async () => {
    await pendingPushRelease();
    const current = () => reg.pushManager.getSubscription();
    const outcome = await repairPush(userId, {
      enabledBy: readPushEnabledBy,
      setEnabledBy: writePushEnabledBy,
      granted: currentPermission() === 'granted',
      subscription: current,
      async ownsRow(endpoint) {
        const { data, error } = await createClient()
          .from('push_subscriptions')
          .select('id')
          .eq('user_id', userId)
          .eq('endpoint', endpoint)
          .limit(1);
        if (error) throw new Error(error.message);
        return (data ?? []).length > 0;
      },
      async register() {
        const sub = await current();
        return sub ? postSubscription(sub) : 503;
      },
      async resubscribe() {
        const key = await fetchPublicKey();
        if (!key) return 503;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
        const status = await postSubscription(sub).catch(() => 503);
        // Never a browser subscription the server does not know.
        if (status >= 300) await sub.unsubscribe().catch(() => false);
        return status;
      },
      unsubscribe: async () => (await current())?.unsubscribe(),
    });
    if (outcome === 'failed' && repair === mine) repair = null;
  })();
  return mine.done;
}

export type SubscribeResult = 'on' | 'denied' | 'not_configured' | 'error';
export type TestResult = PushTestOutcome | 'not_configured' | 'error';

export function usePushSubscription() {
  const { user, accountId, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  const ready = !!userId && !!accountId;
  const [state, setState] = useState<PushDeviceState>('loading');
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [permission, setPermission] = useState<PushPermission>('default');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = currentSupport();
    const p = s === 'supported' ? currentPermission() : 'default';
    setSupport(s);
    setPermission(p);
    if (s !== 'supported') {
      setState(s);
      return;
    }
    try {
      const reg = await registerServiceWorker();
      // The switch must not say "on" for someone else's subscription, or
      // for one the server lost: settle whose it is first.
      if (ready && userId) await repairOnce(userId, reg);
      const sub = await reg.pushManager.getSubscription();
      setState(deviceState({ support: s, permission: p, subscribed: !!sub }));
    } catch (err) {
      console.error('[push] service worker registration failed:', err);
      setState('unsupported');
    }
  }, [ready, userId]);

  useEffect(() => {
    // Browser APIs only exist after mount; the first paint is 'loading',
    // and stays so until the person and workspace are known.
    if (!ready && profileLoading) return;
    void refresh();
  }, [refresh, ready, profileLoading]);

  const subscribe = useCallback(async (): Promise<SubscribeResult> => {
    setBusy(true);
    try {
      const publicKey = await fetchPublicKey();
      if (!publicKey) return 'not_configured';

      const granted = toPushPermission(await Notification.requestPermission());
      setPermission(granted);
      if (granted !== 'granted') {
        setState(granted === 'denied' ? 'denied' : 'off');
        return 'denied';
      }

      const reg = await registerServiceWorker();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      if ((await postSubscription(sub)) >= 300) {
        // The server never learned the endpoint: drop it so the switch
        // does not claim "on" for a device nothing will reach.
        await sub.unsubscribe().catch(() => false);
        setState('off');
        return 'error';
      }
      if (userId) writePushEnabledBy(userId);
      setState('on');
      return 'on';
    } catch (err) {
      console.error('[push] subscribe failed:', err);
      await refresh();
      return 'error';
    } finally {
      setBusy(false);
    }
  }, [refresh, userId]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const reg = await registerServiceWorker();
      const sub = await reg.pushManager.getSubscription();
      writePushEnabledBy(null);
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => null);
        await sub.unsubscribe();
      }
      setState('off');
      return true;
    } catch (err) {
      console.error('[push] unsubscribe failed:', err);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const sendTest = useCallback(async (): Promise<TestResult> => {
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      if (res.status === 503) return 'not_configured';
      if (!res.ok) return 'error';
      const body = (await res.json()) as { outcome?: PushTestOutcome };
      return body.outcome ?? 'error';
    } catch {
      return 'error';
    }
  }, []);

  return {
    state,
    support,
    permission,
    busy,
    refresh,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
