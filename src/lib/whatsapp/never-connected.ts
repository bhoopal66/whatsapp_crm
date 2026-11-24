/**
 * Connection failures after which no request can have left: the address
 * was not found, the connection was refused or never opened, or the
 * server's certificate was rejected (undici writes the request only after
 * the TLS handshake). A lost connection (ECONNRESET, "other side closed")
 * or a timeout while waiting for the answer is none of these.
 */
const BEFORE_ANY_REQUEST: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'INVALID_CA',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * Socket errors an OPEN connection can also end with (a route lost while
 * we wait is reported by the read), so they count only from `connect`.
 */
const WHEN_CONNECTING: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

/**
 * True when a failed `fetch` never opened its connection, so the gateway
 * cannot have seen the request. Takes what fetch threw or the gateway
 * error made from it: undici puts the socket error in `cause`, and our
 * Whapi and OpenWA clients put the fetch error there in turn. Several
 * addresses tried make it an AggregateError, whose every error must be
 * one of these.
 */
export function neverConnected(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof AggregateError && err.errors.length > 0)
    return err.errors.every(neverConnected);
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (typeof code === 'string') {
    if (BEFORE_ANY_REQUEST.has(code)) return true;
    if (!WHEN_CONNECTING.has(code)) return false;
    return (
      syscall === 'connect' ||
      (code === 'ECONNREFUSED' && syscall === undefined)
    );
  }
  return err.cause !== undefined && neverConnected(err.cause);
}
