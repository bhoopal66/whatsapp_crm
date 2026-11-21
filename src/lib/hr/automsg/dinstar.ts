/**
 * HR automated messages: the SMS sender over a Dinstar GSM gateway (SIM
 * ports), package release 032. Template messages only: the text is the
 * row's rendered SMS template body (`req.body`, rendered by the engine
 * from the stored sms template), never free text, and there is never a
 * fallback to or from WhatsApp or RCS.
 *
 * UNVERIFIED WIRE FORMAT: written from Dinstar's 'GSM Gateway HTTP API
 * v202011' document (firmware >= 1102, "new version API" enabled under
 * Mobile Configuration), not tested against a live gateway. Confirm on the
 * real gateway before setting DINSTAR_* (`sms-config.ts`):
 *   POST {baseUrl}/api/send_sms, HTTP Basic auth, JSON body
 *     { text, param: [{ number, user_id }], port?: [0..31],
 *       encoding: 'unicode' | 'gsm-7bit', request_status_report: true }
 *   reply { error_code, sn, sms_in_queue, task_id }: 202 accepted,
 *     400 invalid, 413 too many numbers / text over limit, 500 other,
 *     550 no available port. One number per request.
 *
 * - number: the contact's phone through the shared recipient checks
 *   (`recipient.ts`: company chat only, valid E.164), sent with '+'.
 * - encoding and length: `sms-text.ts`, shared with the template editor;
 *   over 3 segments is the terminal 'text_too_long', before any call.
 * - user_id: a positive 31-bit int from SHA-256 of the outbox row id, so a
 *   retry of the same row reuses it. providerMessageId is
 *   '<task_id>:<user_id>' (task_id, else sn): migration 226 matches the
 *   gateway's later pushes on the ':<user_id>' suffix and the number.
 * - Errors: DinstarSendError { reason, retryable, status }. error_code 400
 *   / 413, HTTP 401 / 403, other HTTP 4xx, a 202 without task_id / sn and
 *   an unknown error_code are terminal; error_code 500 / 550, HTTP 5xx,
 *   network errors, timeouts and the pace limit are retryable. The
 *   password and the number never appear in an error.
 * - Pace: at most cfg.maxPerMinute sends a minute per gateway in this
 *   process (carriers throttle or block SIM cards that burst). The bucket
 *   lives at module level, keyed by the gateway URL, because the drain
 *   builds a new sender every pass. `hasCapacity()` lets the engine leave
 *   a row untouched instead of spending an attempt on it.
 * - TLS: verification is never turned off. With cfg.tlsFingerprint a
 *   dedicated https.Agent accepts only that certificate (the pin replaces
 *   the host name check, so an IP base URL works); the CA checks still
 *   apply, so a self-signed gateway certificate must also be trusted
 *   (NODE_EXTRA_CA_CERTS).
 * - An SMS has no chat message: `messageId` is always null.
 *
 * Server-only.
 */
import { createHash } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SendPort, TemplateSendRequest } from './ports';
import { recipientNumber } from './recipient';
import type { SmsSendConfig } from './sms-config';
import { measureSms } from './sms-text';

export const DEFAULT_DINSTAR_TIMEOUT_MS = 10_000;

export class DinstarSendError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
    readonly status: number | null = null
  ) {
    super(`sms send failed: ${reason}${status !== null ? ` (${status})` : ''}`);
    this.name = 'DinstarSendError';
  }
}

/** A stable positive 31-bit user_id for one outbox row. */
export function smsUserId(outboxId: string): number {
  const h = createHash('sha256').update(outboxId).digest();
  return (h.readUInt32BE(0) % 2147483646) + 1;
}

// ---------- pace limit (module level: one bucket per gateway) ----------

interface Bucket {
  tokens: number;
  last: number;
}
const buckets = new Map<string, Bucket>();

function refill(key: string, cap: number, now: number): Bucket {
  const b = buckets.get(key) ?? { tokens: cap, last: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.last) * cap) / 60_000);
  b.last = now;
  buckets.set(key, b);
  return b;
}

/** Tests only: forget every gateway's bucket. */
export function resetDinstarPace(): void {
  buckets.clear();
}

// ---------- TLS pin ----------

/** checkServerIdentity that accepts only the pinned SHA-256 fingerprint. */
export function pinnedIdentity(
  fingerprint: string
): (host: string, cert: PeerCertificate) => Error | undefined {
  const want = fingerprint.replace(/:/g, '').toLowerCase();
  return (_host, cert) => {
    const got =
      typeof cert?.fingerprint256 === 'string'
        ? cert.fingerprint256.replace(/:/g, '').toLowerCase()
        : '';
    return got === want
      ? undefined
      : new Error('gateway certificate fingerprint mismatch');
  };
}

/** A minimal fetch over node:https with its own (pinned) agent; global TLS settings are never touched. */
function agentFetch(agent: Agent): typeof fetch {
  return ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: init.method,
          headers: init.headers as Record<string, string>,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
              })
            )
          );
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      init.signal?.addEventListener('abort', () =>
        req.destroy(new Error('aborted'))
      );
      req.end(init.body as string);
    })) as unknown as typeof fetch;
}

// ---------- the sender ----------

export function createDinstarSmsSendPort(
  db: SupabaseClient,
  cfg: SmsSendConfig,
  fetchImpl?: typeof fetch,
  timeoutMs: number = DEFAULT_DINSTAR_TIMEOUT_MS,
  now: () => number = Date.now
): SendPort {
  const doFetch =
    fetchImpl ??
    (cfg.tlsFingerprint
      ? agentFetch(
          new Agent({
            keepAlive: false,
            checkServerIdentity: pinnedIdentity(cfg.tlsFingerprint),
          })
        )
      : fetch);
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/send_sms`;
  const auth = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  const cap = cfg.maxPerMinute;

  return {
    hasCapacity() {
      return refill(base, cap, now()).tokens >= 1;
    },

    async send(req: TemplateSendRequest) {
      if (req.body.trim() === '')
        throw new DinstarSendError('no_template_body', false);
      const m = measureSms(req.body);
      if (!m.fits) throw new DinstarSendError('text_too_long', false);
      const to = await recipientNumber(
        db,
        req,
        (reason) => new DinstarSendError(reason, false)
      );
      const bucket = refill(base, cap, now());
      if (bucket.tokens < 1) throw new DinstarSendError('rate_limited', true);
      bucket.tokens -= 1;

      const userId = smsUserId(req.outboxId);
      const body = {
        text: req.body,
        param: [{ number: `+${to}`, user_id: userId }],
        ...(cfg.ports && cfg.ports.length > 0 ? { port: [...cfg.ports] } : {}),
        encoding: m.encoding,
        request_status_report: true,
      };

      // One timer covers the request AND the body read, as in rcs.ts: a
      // gateway that sends a status line and then stalls must not keep
      // send() pending and stop the drain.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      let json: unknown = null;
      try {
        try {
          res = await doFetch(url, {
            method: 'POST',
            signal: ctl.signal,
            headers: {
              'content-type': 'application/json',
              authorization: auth,
            },
            body: JSON.stringify(body),
          });
        } catch {
          // Never surface the underlying error text: it may echo the request.
          throw new DinstarSendError(
            ctl.signal.aborted ? 'timeout' : 'network',
            true
          );
        }
        // An unreadable body is a null body: a 200 then ends as the
        // terminal 'unexpected_response', never resent, because the
        // gateway may have queued the message.
        json = await Promise.race([
          res.json().catch(() => null),
          new Promise<null>((resolve) => {
            if (ctl.signal.aborted) resolve(null);
            ctl.signal.addEventListener('abort', () => resolve(null));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 401 || res.status === 403)
        throw new DinstarSendError('unauthorized', false, res.status);
      if (res.status >= 500)
        throw new DinstarSendError('gateway_unavailable', true, res.status);
      if (!res.ok) throw new DinstarSendError('rejected', false, res.status);

      const j = json as {
        error_code?: unknown;
        task_id?: unknown;
        sn?: unknown;
      } | null;
      const code =
        typeof j?.error_code === 'number'
          ? j.error_code
          : Number(j?.error_code);
      if (code === 202) {
        const id = j?.task_id ?? j?.sn;
        if (
          (typeof id !== 'number' && typeof id !== 'string') ||
          String(id) === ''
        )
          throw new DinstarSendError('no_task_id', false, 202);
        return {
          providerMessageId: `${String(id)}:${userId}`,
          messageId: null,
        };
      }
      if (code === 400)
        throw new DinstarSendError('invalid_request', false, 400);
      if (code === 413) throw new DinstarSendError('too_large', false, 413);
      if (code === 550)
        throw new DinstarSendError('no_available_port', true, 550);
      if (code === 500) throw new DinstarSendError('gateway_error', true, 500);
      throw new DinstarSendError(
        'unexpected_response',
        false,
        Number.isFinite(code) ? code : null
      );
    },
  };
}
