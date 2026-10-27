import { parseTaamulEvent } from '@/lib/taamul-sales/event';
import { taamulSalesDb } from '@/lib/taamul-sales/admin';
import { recordInterested } from '@/lib/taamul-sales/record';
import { verifyTaamulSignature } from '@/lib/taamul-sales/signature';

// POST /api/taamul-sales/webhook — "contact marked as interested" from
// the Taamul sales app (migration 139, docs/taamul-sales.md). No
// session: X-Taamul-Signature (HMAC of the timestamp and the raw body
// with TAAMUL_WEBHOOK_SECRET) proves the sender, checked before the
// body is parsed; no secret configured is a refusal (fail closed).
//
// The sales app retries anything but a 2xx for ~22 hours, so the
// answers are chosen for that: a duplicate, a ping and an unknown event
// type are 200; a failure to store is 503, so the event comes back. The
// work is a few short queries, done before answering rather than in
// after(): an event acknowledged and then lost would never be resent.
// Never log the body: it is customer personal data.

const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status });

export async function POST(request: Request) {
  const secret = process.env.TAAMUL_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error('[taamul-sales] TAAMUL_WEBHOOK_SECRET is not set');
    return refuse(503, 'Not configured');
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return refuse(413, 'Payload too large');
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return refuse(413, 'Payload too large');
  }

  const verdict = verifyTaamulSignature({
    rawBody,
    timestamp: request.headers.get('x-taamul-timestamp'),
    signature: request.headers.get('x-taamul-signature'),
    secret,
  });
  if (!verdict.ok) {
    return refuse(
      401,
      verdict.reason === 'stale'
        ? 'Timestamp out of range'
        : 'Invalid signature'
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return refuse(400, 'Invalid JSON');
  }
  const parsed = parseTaamulEvent(body);
  if (parsed.kind === 'invalid') return refuse(400, parsed.error);
  if (parsed.kind === 'ping')
    return Response.json({ ok: true, status: 'pong' });
  if (parsed.kind === 'ignored') {
    return Response.json({ ok: true, status: 'ignored' });
  }

  const accountId = process.env.TAAMUL_WEBHOOK_ACCOUNT_ID?.trim() ?? '';
  if (!UUID.test(accountId)) {
    console.error(
      '[taamul-sales] TAAMUL_WEBHOOK_ACCOUNT_ID is not a workspace id'
    );
    return refuse(503, 'Not configured');
  }

  const { event } = parsed;
  if (event.contact.phoneError) {
    console.warn(
      `[taamul-sales] event ${event.eventId}: phone unusable (${event.contact.phoneError})`
    );
  }
  try {
    const status = await recordInterested(taamulSalesDb(), accountId, event, {
      deliveryId: request.headers.get('x-taamul-delivery-id'),
      payload: body,
    });
    return Response.json({ ok: true, status });
  } catch (err) {
    console.error(
      `[taamul-sales] event ${event.eventId}: ${err instanceof Error ? err.message : 'failed'}`
    );
    return refuse(503, 'Temporarily unavailable');
  }
}
