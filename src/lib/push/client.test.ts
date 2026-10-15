import { describe, expect, it } from 'vitest';

import {
  deviceState,
  iosNeedsInstall,
  isIosDevice,
  pushSupport,
  readPushEnv,
  shouldOfferPush,
  toPushPermission,
  urlBase64ToUint8Array,
  type PushEnv,
} from './client';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function env(over: Partial<PushEnv> = {}): PushEnv {
  return {
    userAgent: CHROME_UA,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    standalone: false,
    ...over,
  };
}

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe unpadded base64', () => {
    // bytes 0xfb 0xff 0xbf -> standard "+/+/" alphabet
    expect(Array.from(urlBase64ToUint8Array('-_-_'))).toEqual([
      0xfb, 0xff, 0xbf,
    ]);
    expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2]);
  });

  it('round-trips a 65-byte VAPID key', () => {
    const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) % 256);
    const key = Buffer.from(bytes).toString('base64url');
    expect(Array.from(urlBase64ToUint8Array(key))).toEqual(Array.from(bytes));
  });
});

describe('iOS detection', () => {
  it('an iPhone Safari tab needs install', () => {
    const e = env({ userAgent: IPHONE_UA, hasPushManager: false });
    expect(isIosDevice(e)).toBe(true);
    expect(iosNeedsInstall(e)).toBe(true);
    expect(pushSupport(e)).toBe('ios-needs-install');
  });

  it('an installed iPhone app does not', () => {
    const e = env({ userAgent: IPHONE_UA, standalone: true });
    expect(iosNeedsInstall(e)).toBe(false);
    expect(pushSupport(e)).toBe('supported');
  });

  it('treats a touch "Mac" as an iPad, a real Mac as desktop', () => {
    expect(
      isIosDevice(
        env({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 5 })
      )
    ).toBe(true);
    const mac = env({
      userAgent: MAC_UA,
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    expect(isIosDevice(mac)).toBe(false);
    expect(pushSupport(mac)).toBe('supported');
  });
});

describe('pushSupport', () => {
  it('needs a service worker, PushManager and Notification', () => {
    expect(pushSupport(env())).toBe('supported');
    expect(pushSupport(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushSupport(env({ hasNotification: false }))).toBe('unsupported');
  });
});

describe('readPushEnv', () => {
  it('reads standalone from navigator.standalone or display-mode', () => {
    const win = { PushManager: {}, Notification: {} };
    expect(
      readPushEnv({ userAgent: IPHONE_UA, standalone: true }, win).standalone
    ).toBe(true);
    expect(
      readPushEnv(
        { userAgent: IPHONE_UA },
        {
          ...win,
          matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }),
        }
      ).standalone
    ).toBe(true);
    const tab = readPushEnv({ userAgent: CHROME_UA, serviceWorker: {} }, win);
    expect(tab).toMatchObject({
      standalone: false,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
    });
  });

  it('survives a throwing matchMedia', () => {
    const e = readPushEnv(
      { userAgent: CHROME_UA },
      {
        matchMedia: () => {
          throw new Error('nope');
        },
      }
    );
    expect(e.standalone).toBe(false);
    expect(e.hasServiceWorker).toBe(false);
  });
});

describe('permission and device state', () => {
  it('maps Notification.permission', () => {
    expect(toPushPermission('granted')).toBe('granted');
    expect(toPushPermission('denied')).toBe('denied');
    expect(toPushPermission('default')).toBe('default');
    expect(toPushPermission(undefined)).toBe('default');
  });

  it('derives the switch state', () => {
    const s = (
      support: Parameters<typeof deviceState>[0]['support'],
      permission: 'default' | 'granted' | 'denied',
      subscribed: boolean
    ) => deviceState({ support, permission, subscribed });
    expect(s('unsupported', 'granted', true)).toBe('unsupported');
    expect(s('ios-needs-install', 'default', false)).toBe('ios-needs-install');
    expect(s('supported', 'denied', true)).toBe('denied');
    expect(s('supported', 'granted', true)).toBe('on');
    expect(s('supported', 'granted', false)).toBe('off');
    expect(s('supported', 'default', true)).toBe('off');
  });

  it('offers the banner only while the browser has not been asked', () => {
    expect(shouldOfferPush('supported', 'default', false)).toBe(true);
    expect(shouldOfferPush('supported', 'default', true)).toBe(false);
    expect(shouldOfferPush('supported', 'granted', false)).toBe(false);
    expect(shouldOfferPush('ios-needs-install', 'default', false)).toBe(false);
  });
});
