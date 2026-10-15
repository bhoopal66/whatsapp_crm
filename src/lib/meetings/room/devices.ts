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
 * The person dismissing the screen picker is a NotAllowedError too, and
 * is not an error worth showing: they simply chose not to share.
 */
export function isShareCancelled(err: unknown): boolean {
  return classifyMediaError(err) === 'permission_denied';
}
