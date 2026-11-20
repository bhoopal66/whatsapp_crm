import { supabaseAdmin } from '@/lib/automations/admin-client';
import { rcsWebhookConfig } from '@/lib/hr/automsg/rcs-config';
import {
  parseRcsWebhook,
  RCS_SIGNATURE_HEADER,
  verifyRcsSignature,
} from '@/lib/hr/automsg/rcs-webhook';

// POST /api/rcs/webhook — RCS delivery receipts for HR automated messages
// (package release 030b). No session: the X-Rcs-Signature HMAC over the
// raw body proves the sender, checked before anything is parsed or
// written. RCS is off until RCS_WEBHOOK_SECRET and RCS_WORKSPACE_ID are
// set; until then every call answers 501 not_configured.
//
// The workspace is the configured RCS_WORKSPACE_ID, never anything in the
// payload. Each receipt goes through hr_automsg_delivery_record with
// p_channel 'rcs', which matches the provider id among RCS rows only, so
// a WhatsApp message with the same id is never touched. One receipt's
// failure never stops the others.
//
// Never log the payload, the secret or the signature.

const MAX_BODY_BYTES = 256 * 1024;

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status });

async function readCapped(
  request: Request,
  max: number
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const OUTCOMES: ReadonlySet<string> = new Set([
  'recorded',
  'unchanged',
  'failed_terminal',
  'unknown_message',
]);

export async function POST(request: Request) {
  const cfg = rcsWebhookConfig();
  if (!cfg) return refuse(501, 'not_configured');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return refuse(413, 'payload_too_large');
  // Content-Length is absent on a chunked body, so the cap is also
  // enforced while reading: an unsigned caller must not make us buffer
  // an unbounded body before the signature is even checked.
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (!raw) return refuse(413, 'payload_too_large');

  if (
    !verifyRcsSignature(
      raw,
      request.headers.get(RCS_SIGNATURE_HEADER),
      cfg.secret
    )
  ) {
    return refuse(401, 'invalid_signature');
  }

  const parsed = parseRcsWebhook(raw);
  const counts: Record<string, number> = {};
  const add = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const db = supabaseAdmin();
  for (const st of parsed.statuses) {
    try {
      const { data, error } = await db.rpc('hr_automsg_delivery_record', {
        p_account_id: cfg.accountId,
        p_provider_message_id: st.providerId,
        p_state: st.state,
        p_at: st.at.toISOString(),
        p_reason: st.errorCode,
        p_channel: 'rcs',
      });
      if (error) {
        console.error(`[rcs-webhook] record failed: ${error.code ?? 'error'}`);
        add('error');
        continue;
      }
      add(typeof data === 'string' && OUTCOMES.has(data) ? data : 'error');
    } catch {
      console.error('[rcs-webhook] record threw');
      add('error');
    }
  }
  if (parsed.ignored > 0) counts.ignored = parsed.ignored;
  return Response.json({ ok: true, counts });
}
