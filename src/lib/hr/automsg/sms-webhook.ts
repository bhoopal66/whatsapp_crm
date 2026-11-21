/**
 * SMS delivery reports and STOP replies for HR automated messages
 * (package release 032): the pure parts of `POST /api/sms/webhook`
 * (token, IP allow-list, payload mapping). The route checks the IP and
 * the token before anything is parsed or read from the database.
 *
 * UNVERIFIED WIRE FORMAT: written from the push section of Dinstar's 'GSM
 * Gateway HTTP API v202011' document, not checked against a live gateway.
 * Confirm before go-live:
 *   JSON { sn, <one or more of> }:
 *     sms_result:         [{ port, number, user_id, time, status: FAILED |
 *                          SENDING | SENT_OK | DELIVERED, count,
 *                          succ_count, ref_id, imsi }]
 *     sms_deliver_status: [{ port, number, time, ref_id, status_code,
 *                          imsi }]  status_code 0 received by the phone,
 *                          32-63 temporary error, 64-255 permanent error
 *     sms:                [{ incoming_sms_id, port, number, smsc,
 *                          timestamp, text }]  (incoming)
 * The push carries NO signature: it is authenticated by a shared token,
 * header X-Sms-Token (timing-safe against SMS_WEBHOOK_SECRET), or ?token=
 * only when SMS_ALLOW_QUERY_TOKEN=1 and the header is absent; plus an
 * optional exact source-IP allow-list. The workspace comes from server
 * config only (`sms-config.ts`), never from the payload.
 *
 * Mapping: SENT_OK -> sent; DELIVERED and status_code 0 -> delivered;
 * FAILED -> failed (reason 'FAILED'); status_code 64-255 -> failed (reason
 * the code); 32-63 (temporary) -> sent; SENDING and anything else ignored.
 * An sms_result item's ref_id is kept even when its status is ignored, so
 * a later sms_deliver_status (no user_id) can find the message.
 * Incoming sms: only an opt-out is acted on; any other text is dropped
 * here and never stored or logged.
 *
 * `parseSmsWebhook` is tolerant: it never throws, and anything unreadable
 * or not acted on is counted in `ignored`.
 */
import { timingSafeEqual } from 'node:crypto';
import { isOptOut } from '@/lib/hr/agents/guardrails';
import type { SmsWebhookConfig } from './sms-config';

export const SMS_TOKEN_HEADER = 'x-sms-token';

export type SmsDeliveryState = 'sent' | 'delivered' | 'failed';

/** userId set: an sms_result item; null: an sms_deliver_status item. */
export interface SmsStatus {
  userId: string | null;
  refId: string | null;
  number: string;
  state: SmsDeliveryState;
  at: Date | null;
  reason: string | null;
}

export interface SmsRef {
  userId: string;
  number: string;
  refId: string;
}

export interface ParsedSmsWebhook {
  refs: SmsRef[];
  statuses: SmsStatus[];
  optOutNumbers: string[];
  ignored: number;
}

/** The header first; the query token only when allowed and the header is absent. */
export function verifySmsToken(
  header: string | null,
  query: string | null,
  cfg: Pick<SmsWebhookConfig, 'secret' | 'allowQueryToken'>
): boolean {
  const token =
    header !== null
      ? header
      : cfg.allowQueryToken && query !== null
        ? query
        : null;
  if (token === null) return false;
  const given = Buffer.from(token, 'utf8');
  const expected = Buffer.from(cfg.secret, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * An empty list lets every caller through. A list with an unknown caller
 * IP (no EDGE_CLIENT_IP_HEADER, or the header missing) refuses: the list
 * was set to keep everyone else out.
 */
export function ipAllowed(
  ip: string | undefined,
  cfg: Pick<SmsWebhookConfig, 'allowIps'>
): boolean {
  if (cfg.allowIps.length === 0) return true;
  return ip !== undefined && cfg.allowIps.includes(ip);
}

export function isSmsOptOut(text: string): boolean {
  const t = text.trim().toUpperCase();
  return t === 'STOP' || t === 'UNSUBSCRIBE' || isOptOut(text.trim());
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, max: number): string | null =>
  (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) &&
  String(v) !== '' &&
  String(v).length <= max
    ? String(v)
    : null;

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
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const userIdOf = (v: unknown): string | null => {
  const s = str(v, 10);
  return s !== null && /^\d{1,10}$/.test(s) ? s : null;
};
const numberOf = (v: unknown): string | null => {
  const s = str(v, 24);
  return s !== null && /\d/.test(s) ? s : null;
};
const refOf = (v: unknown): string | null => {
  const s = str(v, 64);
  return s !== null && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : null;
};

const RESULT_STATES: Record<string, SmsDeliveryState> = {
  SENT_OK: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
};

export function parseSmsWebhook(raw: Uint8Array): ParsedSmsWebhook {
  const out: ParsedSmsWebhook = {
    refs: [],
    statuses: [],
    optOutNumbers: [],
    ignored: 0,
  };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    out.ignored++;
    return out;
  }
  if (!isObj(body)) {
    out.ignored++;
    return out;
  }

  if (Array.isArray(body.sms_result)) {
    for (const e of body.sms_result) {
      const userId = isObj(e) ? userIdOf(e.user_id) : null;
      const number = isObj(e) ? numberOf(e.number) : null;
      if (!isObj(e) || userId === null || number === null) {
        out.ignored++;
        continue;
      }
      const refId = refOf(e.ref_id);
      if (refId !== null) out.refs.push({ userId, number, refId });
      const state =
        typeof e.status === 'string' ? RESULT_STATES[e.status] : undefined;
      if (!state) {
        out.ignored++;
        continue;
      }
      out.statuses.push({
        userId,
        refId,
        number,
        state,
        at: time(e.time),
        reason: state === 'failed' ? 'FAILED' : null,
      });
    }
  }

  if (Array.isArray(body.sms_deliver_status)) {
    for (const e of body.sms_deliver_status) {
      const number = isObj(e) ? numberOf(e.number) : null;
      const code =
        isObj(e) &&
        typeof e.status_code === 'number' &&
        Number.isInteger(e.status_code)
          ? e.status_code
          : null;
      if (
        !isObj(e) ||
        number === null ||
        code === null ||
        code < 0 ||
        code > 255
      ) {
        out.ignored++;
        continue;
      }
      const state: SmsDeliveryState | null =
        code === 0
          ? 'delivered'
          : code >= 32 && code <= 63
            ? 'sent'
            : code >= 64
              ? 'failed'
              : null;
      if (state === null) {
        out.ignored++;
        continue;
      }
      out.statuses.push({
        userId: null,
        refId: refOf(e.ref_id),
        number,
        state,
        at: time(e.time),
        reason: state === 'failed' ? String(code) : null,
      });
    }
  }

  if (Array.isArray(body.sms)) {
    for (const e of body.sms) {
      const number = isObj(e) ? numberOf(e.number) : null;
      // Any other incoming text is dropped here: never stored, never logged.
      if (
        !isObj(e) ||
        number === null ||
        typeof e.text !== 'string' ||
        !isSmsOptOut(e.text)
      ) {
        out.ignored++;
        continue;
      }
      out.optOutNumbers.push(number);
    }
  }

  if (
    !Array.isArray(body.sms_result) &&
    !Array.isArray(body.sms_deliver_status) &&
    !Array.isArray(body.sms)
  )
    out.ignored++;
  return out;
}
