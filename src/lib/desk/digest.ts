/**
 * The desk reminder digest (migration 234, design 035 D9): one message
 * per company per day listing what is still missing across its banks.
 * Off by default; template only (an approved utility template with
 * {{1}} = application number, {{2}} = the pending summary).
 *
 * The SQL queues and guards (one a day, gap, quiet hours, opt-out, the
 * shared daily cap of 3); this module sends what it claims, marks each
 * once, and recognises a STOP reply. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** A reply that stops reminders: the whole message, any case. */
const STOP_WORDS = new Set([
  'stop',
  'unsubscribe',
  'stop reminders',
  'توقف',
  'إيقاف',
  'ايقاف',
  'الغاء',
  'إلغاء',
]);

export function isStopWord(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!؟?,،\s]+$/u, '')
    .replace(/\s+/g, ' ');
  return t.length > 0 && t.length <= 20 && STOP_WORDS.has(t);
}

export interface DigestClaim {
  id: string;
  accountId: string;
  contactId: string;
  conversationId: string;
  appNumber: string;
  summary: string;
  templateName: string;
  language: string;
}

export interface DigestSender {
  (
    db: SupabaseClient,
    claim: DigestClaim
  ): Promise<{ providerMessageId: string | null; messageId: string | null }>;
}

export interface DigestSummary {
  queued: number;
  sent: number;
  failed: number;
}

/**
 * Queue today's digests, claim what may go now and send each once. A
 * send that throws is marked failed with the error's name only (never
 * its text, which can carry a number or URL); a claim the process never
 * marks becomes 'unconfirmed' in SQL and is never resent.
 */
export async function runDeskDigests(
  db: SupabaseClient,
  send: DigestSender,
  now: () => Date = () => new Date()
): Promise<DigestSummary | null> {
  const summary: DigestSummary = { queued: 0, sent: 0, failed: 0 };
  try {
    const q = await db.rpc('desk_digest_enqueue', {
      p_now: now().toISOString(),
    });
    if (q.error) throw q.error;
    summary.queued = typeof q.data === 'number' ? q.data : 0;
    const c = await db.rpc('desk_digest_claim', {
      p_now: now().toISOString(),
      p_limit: 50,
    });
    if (c.error) throw c.error;
    const rows = (Array.isArray(c.data) ? c.data : []) as Record<
      string,
      unknown
    >[];
    for (const r of rows) {
      const claim: DigestClaim = {
        id: String(r.id),
        accountId: String(r.account_id),
        contactId: String(r.contact_id),
        conversationId: String(r.conversation_id),
        appNumber: String(r.app_number),
        summary: String(r.summary),
        templateName: String(r.template_name),
        language: String(r.language ?? 'en'),
      };
      let outcome: 'sent' | 'failed' = 'sent';
      let provider: string | null = null;
      let message: string | null = null;
      let reason: string | null = null;
      try {
        const res = await send(db, claim);
        provider = res.providerMessageId;
        message = res.messageId;
      } catch (err) {
        outcome = 'failed';
        reason =
          err instanceof DigestRefusal
            ? err.code
            : err instanceof Error
              ? err.name
              : 'error';
      }
      const m = await db.rpc('desk_digest_mark', {
        p_id: claim.id,
        p_outcome: outcome,
        p_provider_message_id: provider,
        p_message_id: message,
        p_reason: reason,
        p_now: now().toISOString(),
      });
      if (m.error)
        console.error('[desk] digest mark failed', m.error.code ?? '');
      if (outcome === 'sent') summary.sent += 1;
      else summary.failed += 1;
    }
    return summary;
  } catch (err) {
    console.error(
      `[desk] digest run failed: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  }
}

/** A send refused before the gateway, by a code safe to store. */
export class DigestRefusal extends Error {
  override readonly name = 'DigestRefusal';
  constructor(readonly code: string) {
    super(`desk digest refused: ${code}`);
  }
}

/** Opts a person out when they replied STOP to a digest. Never throws. */
export async function noteDigestStop(
  db: Pick<SupabaseClient, 'rpc'>,
  accountId: string,
  contactId: string,
  text: string | null | undefined
): Promise<boolean> {
  if (!isStopWord(text)) return false;
  try {
    const { data, error } = await db.rpc('desk_digest_stop', {
      p_account: accountId,
      p_contact: contactId,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
