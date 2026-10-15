import type { DeviceOption, MediaDeviceKind } from './contract';
import type { TrackKind } from './types';

/**
 * Why a camera, microphone or screen could not be opened, in the terms
 * the room shows. Classified from the DOMException name that
 * getUserMedia / getDisplayMedia reject with.
 */
export type DeviceError =
  /** The person (or a browser policy) said no. */
  | 'permission_denied'
  /** No such device, or none matches the constraints. */
  | 'not_found'
  /** The device exists but another app holds it, or the OS failed it. */
  | 'in_use'
  /** No mediaDevices at all: an insecure origin or an old browser. */
  | 'unsupported'
  | 'unknown';

export function classifyMediaError(err: unknown): DeviceError {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission_denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not_found';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in_use';
    case 'TypeError':
      // Thrown when navigator.mediaDevices exists but the call is not
      // allowed in this context (e.g. getDisplayMedia without a gesture).
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/**
 * The tracks a preview opened that nobody keeps. A preview whose page
 * was left mid-open must stop what it already holds: getUserMedia for
 * the mic can resolve before the camera, and a mic nobody references
 * stays live (the browser's recording dot) until the tab closes.
 * Tracks the engine still holds are never stopped.
 */
export function tracksToRelease<T>(
  opened: readonly (T | null)[],
  kept: readonly (T | null)[]
): T[] {
  return opened.filter((t): t is T => t !== null && !kept.includes(t));
}

/** Phases in which a device that just opened is still wanted. */
const KEEP_OPENED_IN = new Set(['lobby', 'joining', 'live', 'reconnecting']);

/**
 * Whether a device that finished opening may be installed. Opening
 * takes a permission prompt or a picker, during which the person may
 * leave, be removed, or see the meeting end; that stops every device
 * first, and a track installed after it keeps the camera light on
 * behind the end screen. `at` is captured before the open: a changed
 * session (leave, end, removal, a give-up) or epoch (unmount) refuses,
 * as does a phase with no room or preview to show it in.
 */
export function keepOpenedTrack(
  at: { session: number; epoch: number },
  now: { session: number; epoch: number; phase: string }
): boolean {
  return (
    at.session === now.session &&
    at.epoch === now.epoch &&
    KEEP_OPENED_IN.has(now.phase)
  );
}

/**
 * Switching cameras opens the new one while the old is live, which many
 * phones and some USB cameras refuse as busy. Only these are worth one
 * retry once the old camera is released; a refusal or a missing device
 * would fail again.
 */
export function isBusyDeviceError(err: unknown): boolean {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  return name === 'NotReadableError' || name === 'AbortError';
}

/**
 * The person dismissing the screen picker is a NotAllowedError too, and
 * is not an error worth showing: they simply chose not to share.
 */
export function isShareCancelled(err: unknown): boolean {
  return classifyMediaError(err) === 'permission_denied';
}

/**
 * What a failed publish releases. A local track the SFU never received
 * is released, so the room reads it as off and the toggle's turn-on path
 * (open the device, publish through the queue) is the retry: the mic
 * and camera with an `unknown` device error, since the person sees
 * their own mic or camera as on otherwise and nobody hears or sees
 * them; the screen silently, the share button reading "share" again.
 * Never a track the engine has since replaced or dropped, and never a
 * kind that already has a live publication, so a duplicate publish that
 * fails cannot stop the track the first one is sending.
 */
export function afterFailedPublish<T>(
  failed: readonly { track: T; kind: TrackKind }[],
  held: Readonly<Record<TrackKind, T | null>>,
  published: ReadonlySet<TrackKind>
): { kind: TrackKind; error: DeviceError | null }[] {
  return failed
    .filter((f) => held[f.kind] === f.track && !published.has(f.kind))
    .map((f) => ({
      kind: f.kind,
      error: f.kind === 'screen' ? null : 'unknown',
    }));
}

// --- device choice (v2) ------------------------------------------------

export const DEVICE_PREFS_KEY = 'meetings.devices.v1';

export type DevicePrefs = Record<MediaDeviceKind, string | null>;

const DEVICE_KINDS: readonly MediaDeviceKind[] = [
  'audioinput',
  'videoinput',
  'audiooutput',
];

/** localStorage's value, read tolerantly: anything odd is "the default". */
export function parseDevicePrefs(raw: string | null): DevicePrefs {
  const out: DevicePrefs = {
    audioinput: null,
    videoinput: null,
    audiooutput: null,
  };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const kind of DEVICE_KINDS) {
    const v = (parsed as Record<string, unknown>)[kind];
    if (typeof v === 'string' && v && v.length <= 512) out[kind] = v;
  }
  return out;
}

/**
 * enumerateDevices() grouped by kind. Chrome's `default` and
 * `communications` entries are aliases of a real device and are left
 * out: "the browser default" is a null choice, not an option.
 */
export function deviceOptionsFrom(
  devices: readonly { kind: string; deviceId: string; label: string }[]
): Record<MediaDeviceKind, DeviceOption[]> {
  const out: Record<MediaDeviceKind, DeviceOption[]> = {
    audioinput: [],
    videoinput: [],
    audiooutput: [],
  };
  for (const d of devices) {
    if (!(DEVICE_KINDS as readonly string[]).includes(d.kind)) continue;
    if (!d.deviceId || d.deviceId === 'default') continue;
    if (d.deviceId === 'communications') continue;
    const list = out[d.kind as MediaDeviceKind];
    if (!list.some((o) => o.deviceId === d.deviceId)) {
      list.push({ deviceId: d.deviceId, label: d.label });
    }
  }
  return out;
}

/**
 * The choice to show: a stored device that is no longer plugged in
 * reads as the default. With no listed devices (no permission yet, so
 * no ids) the stored choice stands.
 */
export function effectiveSelection(
  prefs: DevicePrefs,
  options: Record<MediaDeviceKind, DeviceOption[]>
): DevicePrefs {
  const out = { ...prefs };
  for (const kind of DEVICE_KINDS) {
    const id = prefs[kind];
    if (
      id &&
      options[kind].length &&
      !options[kind].some((o) => o.deviceId === id)
    ) {
      out[kind] = null;
    }
  }
  return out;
}

/** getUserMedia constraints for the mic or camera, on a chosen device. */
export function mediaConstraints(
  kind: 'audio' | 'video',
  deviceId: string | null
): { audio?: Record<string, unknown>; video?: Record<string, unknown> } {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  return kind === 'audio'
    ? {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...device,
        },
      }
    : {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...device,
        },
      };
}
