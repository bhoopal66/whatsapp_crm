// ============================================================
// Loads the Linkus SDK for Web (ys-webrtc-sdk-core) at runtime, in the
// browser only (module 015). The SDK's licence is "Proprietary
// License", so it is not an npm dependency of this app: the operator
// hosts the bundle and points NEXT_PUBLIC_LINKUS_SDK_URL at it (inlined
// at build time — changing it needs a rebuild). Unset, nothing loads
// and the call screens stay in desk-phone mode.
//
// Both builds work. An ES module is imported directly; anything else
// (the UMD or IIFE build, or a module import refused for CORS) is
// loaded with a <script> tag and read from the `YSWebRTC` global, the
// name Yeastar's guide uses for the UMD build.
// ============================================================

/** The two /api/pbx/me flags that decide whether the SDK loads. */
export interface SoftphoneFlags {
  softphoneEnabled: boolean;
  softphoneAvailable: boolean;
}

/** The parts of the SDK this app uses (its own types are not imported). */
export interface LinkusEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface LinkusPhone extends LinkusEmitter {
  start(): unknown;
  call(number: string): Promise<unknown>;
  answer(callId: string): Promise<unknown>;
  reject(callId: string): boolean;
  hangup(callId: string): boolean;
  mute(callId: string): boolean;
  unmute(callId: string): boolean;
  hold(callId: string): boolean;
  unhold(callId: string): boolean;
  dtmf(callId: string, digit: string): boolean;
}
export interface LinkusOperator {
  phone: LinkusPhone;
  pbx: LinkusEmitter;
  destroy(): void;
}
export interface LinkusInitParams {
  username: string;
  secret: string;
  pbxURL: string;
  userAgent?: 'WebPC' | 'WebClient';
}
export interface LinkusSdk {
  init(params: LinkusInitParams): Promise<LinkusOperator>;
}

export const LINKUS_GLOBAL = 'YSWebRTC';
export const LOAD_TIMEOUT_MS = 20_000;

/** The operator's SDK bundle URL, or null (desk-phone mode). */
export function linkusSdkUrl(): string | null {
  return process.env.NEXT_PUBLIC_LINKUS_SDK_URL?.trim() || null;
}

/** Only a person whose softphone is on, on a PBX with SDK credentials. */
export function shouldLoadSoftphone(
  me: SoftphoneFlags | null,
  url: string | null
): boolean {
  return Boolean(url && me?.softphoneEnabled && me.softphoneAvailable);
}

/** The SDK object in a module namespace or global, if it is one. */
export function pickSdk(candidate: unknown): LinkusSdk | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const c = candidate as Record<string, unknown>;
  if (typeof c.init === 'function') return c as unknown as LinkusSdk;
  return c.default && c.default !== c ? pickSdk(c.default) : null;
}

/** UMD / IIFE builds by name go straight to a <script> tag. */
function scriptOnly(url: string): boolean {
  return /\.(umd|iife)(\.min)?\.js(\?|#|$)/i.test(url);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms / 1000} s`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function injectScript(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.appendChild(el);
  });
}

export interface LoadDeps {
  importer?: (url: string) => Promise<unknown>;
  injectScript?: (url: string) => Promise<void>;
  global?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * The SDK for this person, or null when it must not load (server side,
 * no URL, softphone off for them, or no SDK credentials on the PBX).
 * Rejects with a plain-words Error when the bundle cannot be loaded.
 */
export async function loadLinkusSdk(
  me: SoftphoneFlags | null,
  url: string | null = linkusSdkUrl(),
  deps: LoadDeps = {}
): Promise<LinkusSdk | null> {
  const g =
    deps.global ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as Record<string, unknown>));
  if (!g || !url || !shouldLoadSoftphone(me, url)) return null;
  const ms = deps.timeoutMs ?? LOAD_TIMEOUT_MS;

  if (!scriptOnly(url)) {
    const importer =
      deps.importer ??
      ((u: string) => import(/* webpackIgnore: true */ /* @vite-ignore */ u));
    try {
      const mod = await withTimeout(importer(url), ms, 'Loading the softphone');
      const sdk = pickSdk(mod) ?? pickSdk(g[LINKUS_GLOBAL]);
      if (sdk) return sdk;
    } catch {
      // Not an ES module, or refused (CORS): try a classic script.
    }
  }
  try {
    await withTimeout(
      (deps.injectScript ?? injectScript)(url),
      ms,
      'Loading the softphone'
    );
  } catch (err) {
    throw new Error(
      `The softphone could not be loaded from ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const sdk = pickSdk(g[LINKUS_GLOBAL]);
  if (!sdk)
    throw new Error(
      `${url} loaded, but it is not the Linkus SDK for Web (no ${LINKUS_GLOBAL}.init)`
    );
  return sdk;
}
