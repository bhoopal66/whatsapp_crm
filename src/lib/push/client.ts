/**
 * Browser-side web push helpers, kept pure so they run under vitest's
 * node environment. `use-push-subscription.ts` reads the real
 * navigator/window into a `PushEnv` and decides from it here.
 */

/** A VAPID public key (URL-safe base64, unpadded) as push expects it. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** What the hook reads off the browser, so the decisions are testable. */
export interface PushEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Running as an installed app (display-mode standalone, or iOS's navigator.standalone). */
  standalone: boolean;
}

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  serviceWorker?: unknown;
  standalone?: boolean;
}

interface WindowLike {
  PushManager?: unknown;
  Notification?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
}

export function readPushEnv(nav: NavigatorLike, win: WindowLike): PushEnv {
  let standalone = nav.standalone === true;
  try {
    if (!standalone && typeof win.matchMedia === 'function') {
      standalone = win.matchMedia('(display-mode: standalone)').matches;
    }
  } catch {
    // matchMedia unavailable: treat as a browser tab.
  }
  return {
    userAgent: nav.userAgent ?? '',
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    hasServiceWorker: 'serviceWorker' in nav && !!nav.serviceWorker,
    hasPushManager: !!win.PushManager,
    hasNotification: !!win.Notification,
    standalone,
  };
}

/**
 * iPhone, iPod or iPad. iPadOS 13+ reports a desktop Mac user agent, so
 * a "Macintosh"/MacIntel device with a touch screen counts as an iPad.
 */
export function isIosDevice(env: PushEnv): boolean {
  if (/iPhone|iPad|iPod/i.test(env.userAgent)) return true;
  const mac = /Macintosh/i.test(env.userAgent) || env.platform === 'MacIntel';
  return mac && (env.maxTouchPoints ?? 0) > 1;
}

/** iOS delivers web push only to a Home Screen app, never to a Safari tab. */
export function iosNeedsInstall(env: PushEnv): boolean {
  return isIosDevice(env) && !env.standalone;
}

export type PushSupport = 'supported' | 'unsupported' | 'ios-needs-install';

export function pushSupport(env: PushEnv): PushSupport {
  // Checked first: a Safari tab on iOS has no PushManager at all, and
  // "add to Home Screen" is the answer there, not "unsupported".
  if (iosNeedsInstall(env)) return 'ios-needs-install';
  return env.hasServiceWorker && env.hasPushManager && env.hasNotification
    ? 'supported'
    : 'unsupported';
}

export type PushPermission = 'default' | 'granted' | 'denied';

/** Notification.permission, defensively ('default' for anything odd). */
export function toPushPermission(value: unknown): PushPermission {
  return value === 'granted' || value === 'denied' ? value : 'default';
}

export type PushDeviceState =
  'unsupported' | 'ios-needs-install' | 'denied' | 'off' | 'on' | 'loading';

/** This device's push state, as the settings switch shows it. */
export function deviceState(input: {
  support: PushSupport;
  permission: PushPermission;
  subscribed: boolean;
}): PushDeviceState {
  if (input.support !== 'supported') return input.support;
  if (input.permission === 'denied') return 'denied';
  return input.subscribed && input.permission === 'granted' ? 'on' : 'off';
}

/** Whether the one-time "Turn on notifications" banner may show. */
export function shouldOfferPush(
  support: PushSupport,
  permission: PushPermission,
  dismissed: boolean
): boolean {
  return support === 'supported' && permission === 'default' && !dismissed;
}

/**
 * Where the banner's "Not now" is remembered: this browser, per person,
 * so the next person signing in on a shared PC is still asked.
 */
export function pushPromptDismissKey(userId: string): string {
  return `taamul.push-prompt-dismissed:${userId}`;
}

/** Everything the one-time banner waits on; null = not known yet. */
export interface PushPromptInput {
  support: PushSupport | null;
  permission: PushPermission;
  /** This browser already has a live subscription. */
  subscribed: boolean;
  dismissed: boolean;
  /** The install has VAPID keys (GET /api/push/config's publicKey). */
  serverConfigured: boolean | null;
  /** Bank guests have team chat only; push would bring them nothing. */
  bankGuest: boolean;
}

/** Whether the one-time "Turn on notifications" banner shows now. */
export function shouldShowPushPrompt(input: PushPromptInput): boolean {
  if (input.support === null || input.bankGuest || input.subscribed)
    return false;
  if (input.serverConfigured !== true) return false;
  return shouldOfferPush(input.support, input.permission, input.dismissed);
}
