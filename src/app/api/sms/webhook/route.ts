import { supabaseAdmin } from '@/lib/automations/admin-client';
import { markOptedOut } from '@/lib/ai/opt-out';
import { clientIp } from '@/lib/edge/client-ip';
import { smsWebhookConfig } from '@/lib/hr/automsg/sms-config';
import {
  ipAllowed,
  parseSmsWebhook,
  SMS_TOKEN_HEADER,
  verifySmsToken,
} from '@/lib/hr/automsg/sms-webhook';

// POST /api/sms/webhook — the Dinstar SMS gateway's push for HR automated
// messages (package release 032): delivery reports and incoming texts.
// No session and no signature (the gateway cannot sign): the source IP
// (when SMS_WEBHOOK_ALLOW_IPS is set) and the shared token prove the
// sender, both checked before anything is parsed or written. Off until
// SMS_WEBHOOK_SECRET and SMS_WORKSPACE_ID are set; until then every call
// answers 501 not_configured.
//
// The workspace is the configured SMS_WORKSPACE_ID, never anything in the
// payload. Ref ids are stored first, so a delivery report in the same push
// can find its message; then each status goes to migration 226's matcher
// (by user id with one, else by ref id or number); then each STOP opts its
// contact out of every channel, as an HR chat's STOP does
// (`lib/hr/agents/inbound.ts`). One item's failure never stops the others.
//
// Never log the payload, a number, the token or the secret.

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

const STATUS_OUTCOMES: ReadonlySet<string> = new Set([
  'recorded',
  'unchanged',
  'failed_terminal',
  'unknown_message',
]);

export async function POST(request: Request) {
  const cfg = smsWebhookConfig();
  if (!cfg) return refuse(501, 'not_configured');

  if (!ipAllowed(clientIp(request.headers), cfg))
    return refuse(401, 'forbidden');
  const query = new URL(request.url).searchParams.get('token');
  if (!verifySmsToken(request.headers.get(SMS_TOKEN_HEADER), query, cfg))
    return refuse(401, 'invalid_token');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return refuse(413, 'payload_too_large');
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (!raw) return refuse(413, 'payload_too_large');

  const parsed = parseSmsWebhook(raw);
  const counts: Record<string, number> = {};
  const add = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const db = supabaseAdmin();
  const p_account_id = cfg.accountId;

  for (const rf of parsed.refs) {
    try {
      const { data, error } = await db.rpc('hr_automsg_sms_ref_record', {
        p_account_id,
        p_user_id: rf.userId,
        p_number: rf.number,
        p_ref_id: rf.refId,
      });
      if (error) {
        console.error(`[sms-webhook] ref failed: ${error.code ?? 'error'}`);
        add('ref_error');
      } else if (data === 'conflict') add('ref_conflict');
    } catch {
      console.error('[sms-webhook] ref threw');
      add('ref_error');
    }
  }

  for (const st of parsed.statuses) {
    try {
      const at = st.at ? st.at.toISOString() : null;
      const { data, error } =
        st.userId !== null
          ? await db.rpc('hr_automsg_sms_delivery_record', {
              p_account_id,
              p_user_id: st.userId,
              p_number: st.number,
              p_state: st.state,
              p_at: at,
              p_reason: st.reason,
            })
          : await db.rpc('hr_automsg_sms_dlr_record', {
              p_account_id,
              p_ref_id: st.refId,
              p_number: st.number,
              p_state: st.state,
              p_at: at,
              p_reason: st.reason,
            });
      if (error) {
        console.error(`[sms-webhook] status failed: ${error.code ?? 'error'}`);
        add('status_error');
        continue;
      }
      add(
        typeof data === 'string' && STATUS_OUTCOMES.has(data)
          ? data
          : 'status_error'
      );
    } catch {
      console.error('[sms-webhook] status threw');
      add('status_error');
    }
  }

  for (const number of parsed.optOutNumbers) {
    try {
      const { data, error } = await db.rpc('hr_automsg_sms_contact', {
        p_account_id,
        p_number: number,
      });
      if (error) throw error;
      if (typeof data !== 'string' || data === '') {
        add('optout_not_found');
        continue;
      }
      await markOptedOut(db, { accountId: p_account_id, contactId: data });
      const { error: supersedeError } = await db.rpc('hr_agent_supersede', {
        p_account_id,
        p_contact_id: data,
      });
      if (supersedeError) throw supersedeError;
      add('optout_recorded');
    } catch {
      console.error('[sms-webhook] opt-out failed');
      add('optout_error');
    }
  }

  if (parsed.ignored > 0) counts.ignored = parsed.ignored;
  return Response.json({ ok: true, counts });
}
