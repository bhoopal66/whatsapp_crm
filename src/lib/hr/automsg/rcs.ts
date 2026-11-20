/**
 * HR automated messages: the RCS sender (package release 030b). Template
 * messages only; there is never an SMS or WhatsApp fallback and never free
 * text.
 *
 * UNVERIFIED WIRE FORMAT: no RCS provider is chosen yet (UAE availability
 * unconfirmed). The request / response shape below is the package's
 * neutral placeholder and MUST be mapped to the chosen provider's API
 * before go-live (`rcs-config.ts` keeps it off until then):
 *   POST {baseUrl}/messages, Authorization: Bearer <token>, body:
 *     { to, senderId, templateId, language, params: [{ name, value }...], clientRef }
 *   2xx response: { messageId } (or { id }) -> providerMessageId. A 2xx
 *   without one is the terminal 'no_message_id'.
 *
 * - templateId = req.metaTemplateName: for an RCS row the template's
 *   `meta_template_name` holds the RCS provider template id (migration 215).
 * - params follow the stored template's {name}/{slot} first-use order, as
 *   the Meta body params do (`metaBodyParams` in send.ts).
 * - to: the contact's phone, loaded inside the account and normalised like
 *   the WhatsApp sender's, sent with a leading '+'.
 * - Never a personal chat (migration 191): refused before any call.
 * - Errors: RcsSendError { reason, retryable, status }. network / timeout /
 *   429 / 5xx retryable; 401 / 403 'unauthorized', other 4xx 'rejected',
 *   terminal. The token never appears in an error.
 * - clientRef = conversationId (correlation only; the provider is not
 *   assumed to dedupe on it).
 * - An RCS message has no chat message: `messageId` is always null.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type { SendPort, TemplateSendRequest } from './ports';
import type { RcsSendConfig } from './rcs-config';

export const DEFAULT_RCS_TIMEOUT_MS = 10_000;

export class RcsSendError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
    readonly status: number | null = null
  ) {
    super(
      `rcs send failed: ${reason}${status !== null ? ` (http ${status})` : ''}`
    );
    this.name = 'RcsSendError';
  }
}

type Param = keyof TemplateSendRequest['params'];
const TOKEN = /\{(name|slot)\}/g;

/** The provider params, named, in the stored template's token order. */
export function rcsParams(
  req: TemplateSendRequest
): { name: Param; value: string }[] {
  const tokens = [...req.templateBody.matchAll(TOKEN)].map(
    (m) => m[1] as Param
  );
  return [...new Set(tokens)].map((name) => ({
    name,
    value: req.params[name],
  }));
}

/** The contact's E.164 number (without '+'), after the personal-chat refusal. */
async function recipient(
  db: SupabaseClient,
  req: TemplateSendRequest
): Promise<string> {
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, account_id, contact_id, personal_owner_id')
    .eq('id', req.conversationId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (convErr || !conv) throw new RcsSendError('conversation_missing', false);
  if (conv.personal_owner_id) throw new RcsSendError('personal_number', false);
  if (conv.contact_id !== req.contactId)
    throw new RcsSendError('conversation_missing', false);

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', req.contactId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone)
    throw new Error('contact not found for this account');
  const to = sanitizePhoneForMeta(String(contact.phone));
  if (!isValidE164(to)) throw new RcsSendError('invalid_number', false);
  return to;
}

export function createRcsSendPort(
  db: SupabaseClient,
  cfg: RcsSendConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_RCS_TIMEOUT_MS
): SendPort {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;
  return {
    async send(req) {
      if (req.metaTemplateName.trim() === '')
        throw new RcsSendError('unknown_template', false);
      const to = await recipient(db, req);
      const body = {
        to: `+${to}`,
        senderId: cfg.senderId,
        templateId: req.metaTemplateName,
        language: req.language,
        params: rcsParams(req),
        clientRef: req.conversationId,
      };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          signal: ctl.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.token}`,
          },
          body: JSON.stringify(body),
        });
      } catch {
        // Never surface the underlying error text: it may echo the request.
        throw new RcsSendError(
          ctl.signal.aborted ? 'timeout' : 'network',
          true
        );
      } finally {
        clearTimeout(timer);
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (res.ok) {
        const j = json as { messageId?: unknown; id?: unknown } | null;
        const id = typeof j?.messageId === 'string' ? j.messageId : j?.id;
        if (typeof id !== 'string' || id === '')
          throw new RcsSendError('no_message_id', false, res.status);
        return { providerMessageId: id, messageId: null };
      }
      if (res.status === 429) throw new RcsSendError('rate_limited', true, 429);
      if (res.status >= 500)
        throw new RcsSendError('provider_unavailable', true, res.status);
      if (res.status === 401 || res.status === 403)
        throw new RcsSendError('unauthorized', false, res.status);
      throw new RcsSendError('rejected', false, res.status);
    },
  };
}
