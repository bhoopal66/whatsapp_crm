import crypto from 'node:crypto';
import { after } from 'next/server';

import { clientIp, RateLimiter, RpcRateStore } from '@/lib/edge';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { loadPbxWebhookSecret, PbxConnectionError } from '@/lib/pbx/connection';
import { ingestPbxEvent } from '@/lib/pbx/process';
import { verifyYeastarWebhookSignature } from '@/lib/pbx/yeastar/webhook';

// POST /api/pbx/yeastar/events/{token} — the Yeastar webhook push.
// No session: the path token finds the connection and X-Signature
// (HMAC of the raw body with the webhook secret) proves it; no secret
// stored is a refusal (fail closed). PBX_WEBHOOK_ALLOWED_IPS (comma
// list, read through EDGE_CLIENT_IP_HEADER) narrows the senders. The
// body is one event or an array; each is processed in order inside
// after(), awaited there, so the PBX gets its 200 at once.

export const maxDuration = 60;

const TOKEN = /^[A-Za-z0-9]{32,128}$/;
const SCOPE = 'webhook.pbx';
let limiter: RateLimiter | null = null;

const refuse = (status: number, error: string, headers?: HeadersInit) =>
  Response.json({ error }, { status, headers });

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  if (!TOKEN.test(token)) return refuse(404, 'Not found');

  const allowed = process.env.PBX_WEBHOOK_ALLOWED_IPS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed?.length) {
    const ip = clientIp(request.headers);
    if (!ip || !allowed.includes(ip)) return refuse(403, 'Forbidden');
  }

  const db = pbxServiceDb();
  limiter ??= new RateLimiter(new RpcRateStore(db), {
    [SCOPE]: { limit: 100, windowMs: 1000, failOpen: true },
  });
  const tokenKey = crypto.createHash('sha256').update(token).digest('hex');
  const [lookup, rate] = await Promise.all([
    db
      .from('pbx_connections')
      .select('id')
      .eq('webhook_path_token', token)
      .maybeSingle(),
    limiter.check(SCOPE, tokenKey),
  ]);
  if (lookup.error) return refuse(503, 'Temporarily unavailable');
  const connectionId = (lookup.data as { id: string } | null)?.id;
  if (!connectionId) return refuse(404, 'Not found');
  if (!rate.allowed) {
    return refuse(429, 'Too many requests', {
      'Retry-After': String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))),
    });
  }

  let secret: string | null;
  try {
    secret = await loadPbxWebhookSecret(db, connectionId);
  } catch (err) {
    if (!(err instanceof PbxConnectionError)) {
      return refuse(503, 'Temporarily unavailable');
    }
    console.error(`[pbx] ${connectionId}: ${err.message}`);
    secret = null;
  }
  const rawBody = await request.text();
  if (
    !secret ||
    !verifyYeastarWebhookSignature(
      rawBody,
      request.headers.get('x-signature'),
      secret
    )
  ) {
    return refuse(401, 'Invalid signature');
  }

  let body: unknown = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Kept as text: the processor records why it could not be read.
  }
  const events = Array.isArray(body) ? body : [body];
  const receivedAt = new Date().toISOString();
  after(async () => {
    for (const payload of events) {
      try {
        await ingestPbxEvent({ db, connectionId, payload, receivedAt });
      } catch (err) {
        console.error(`[pbx] ${connectionId}: event processing failed:`, err);
      }
    }
  });
  return Response.json({ ok: true, received: events.length });
}
