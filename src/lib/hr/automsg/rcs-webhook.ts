/**
 * RCS delivery receipts for HR automated messages (package release 030b):
 * the pure parts of `POST /api/rcs/webhook` (signature and payload
 * mapping). The route checks the signature over the RAW bytes before
 * anything is parsed or read from the database.
 *
 * UNVERIFIED WIRE FORMAT: no RCS provider is chosen yet. Neutral
 * placeholder, to be mapped to the chosen provider:
 *   header  X-Rcs-Signature: 'sha256=' + hex(HMAC-SHA256(rawBody,
 *           RCS_WEBHOOK_SECRET)), compared timing-safe.
 *   body    { events: [{ messageId, status: sent|delivered|read|failed,
 *           timestamp (ISO or epoch seconds), errorCode? }] }
 * `parseRcsWebhook` is tolerant: it never throws, and anything unreadable
 * is counted in `ignored`. The workspace comes from server config only
 * (`RCS_WORKSPACE_ID`, `rcs-config.ts`), never from the payload.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RCS_SIGNATURE_HEADER = 'x-rcs-signature';

export type RcsDeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

export interface RcsStatus {
  /** The provider's message id, as stored when the message was sent. */
  providerId: string;
  state: RcsDeliveryState;
  at: Date;
  /** Set only for `failed`; 'unknown' when the provider gave no code. */
  errorCode: string | null;
}

export interface ParsedRcsWebhook {
  statuses: RcsStatus[];
  ignored: number;
}

export function verifyRcsSignature(
  raw: Uint8Array,
  header: unknown,
  secret: string
): boolean {
  if (typeof header !== 'string' || !/^sha256=[0-9a-fA-F]{64}$/.test(header))
    return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATES: ReadonlySet<string> = new Set<RcsDeliveryState>([
  'sent',
  'delivered',
  'read',
  'failed',
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function time(v: unknown): Date | null {
  if (
    typeof v === 'number' ||
    (typeof v === 'string' && /^\d{1,12}$/.test(v))
  ) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n < 1e12
      ? new Date(n * 1000)
      : null;
  }
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseRcsWebhook(raw: Uint8Array): ParsedRcsWebhook {
  const out: ParsedRcsWebhook = { statuses: [], ignored: 0 };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    out.ignored++;
    return out;
  }
  if (!isObj(body) || !Array.isArray(body.events)) {
    out.ignored++;
    return out;
  }
  for (const e of body.events) {
    if (!isObj(e)) {
      out.ignored++;
      continue;
    }
    const providerId =
      typeof e.messageId === 'string' &&
      e.messageId !== '' &&
      e.messageId.length <= 256
        ? e.messageId
        : null;
    const state =
      typeof e.status === 'string' && STATES.has(e.status)
        ? (e.status as RcsDeliveryState)
        : null;
    const at = time(e.timestamp);
    if (providerId === null || state === null || at === null) {
      out.ignored++;
      continue;
    }
    const code =
      typeof e.errorCode === 'string' || typeof e.errorCode === 'number'
        ? String(e.errorCode).slice(0, 32)
        : null;
    out.statuses.push({
      providerId,
      state,
      at,
      errorCode: state === 'failed' ? code || 'unknown' : null,
    });
  }
  return out;
}
