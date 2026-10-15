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
