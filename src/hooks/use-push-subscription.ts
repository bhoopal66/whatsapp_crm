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

export type SubscribeResult = 'on' | 'denied' | 'not_configured' | 'error';
export type TestResult = 'sent' | 'none' | 'not_configured' | 'error';

export function usePushSubscription() {
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
      const sub = await reg.pushManager.getSubscription();
      setState(deviceState({ support: s, permission: p, subscribed: !!sub }));
    } catch (err) {
      console.error('[push] service worker registration failed:', err);
      setState('unsupported');
    }
  }, []);

  useEffect(() => {
    // Browser APIs only exist after mount; the first paint is 'loading'.
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async (): Promise<SubscribeResult> => {
    setBusy(true);
    try {
      const configRes = await fetch('/api/push/config');
      const config = configRes.ok
        ? ((await configRes.json()) as { publicKey?: string | null })
        : null;
      if (!config?.publicKey) return 'not_configured';

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
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        }));
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
      if (!res.ok) {
        // The server never learned the endpoint: drop it so the switch
        // does not claim "on" for a device nothing will reach.
        await sub.unsubscribe().catch(() => false);
        setState('off');
        return 'error';
      }
      setState('on');
      return 'on';
    } catch (err) {
      console.error('[push] subscribe failed:', err);
      await refresh();
      return 'error';
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const reg = await registerServiceWorker();
      const sub = await reg.pushManager.getSubscription();
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
      const body = (await res.json()) as { sent?: number };
      return (body.sent ?? 0) > 0 ? 'sent' : 'none';
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
