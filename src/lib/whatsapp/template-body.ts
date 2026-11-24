// ============================================================
// Template body resolution — the local `message_templates` row for a
// send, and the substituted body text we persist alongside it.
//
// Every path that sends a template needs the same two things:
//
//   1. the row (for the send-builder's header/button components), and
//   2. the rendered body, so `messages.content_text` carries the text
//      the customer actually received rather than NULL (issue #483).
//
// Both used to be done ad hoc per caller — the dashboard composer
// rendered the body client-side and posted it as `content_text`, while
// the public API and the automation engine stored nothing, so their
// sends landed in the Inbox as empty bubbles.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableKeys } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

/**
 * Substitute a template body's placeholders. Positional `{{1}}`,
 * `{{2}}`… take `params[N-1]`; named `{{customer_name}}` placeholders
 * (a template synced from Meta in its NAMED format) take their slot in
 * `extractVariableKeys` order, the order a broadcast resolves values
 * in. A placeholder with no corresponding param is left as-is rather
 * than blanked, so a caller that under-supplies params gets a visible
 * `{{2}}` instead of a silently truncated sentence.
 */
export function renderTemplateBody(body: string, params: string[]): string {
  const keys = extractVariableKeys(body);
  // One pass, so a substituted value that itself contains `{{…}}` is
  // never substituted again.
  return body.replace(/\{\{(\d+|[a-z_][a-z0-9_]*)\}\}/g, (match, key) => {
    const idx = /^\d+$/.test(key) ? Number(key) - 1 : keys.indexOf(key);
    return (idx >= 0 ? params[idx] : undefined) ?? match;
  });
}

/**
 * Positional body values out of either param shape a caller may send:
 * the structured `{ body: [...] }` object the composer posts, or the
 * legacy flat array. Structured wins — `sendTemplateMessage` merges
 * them the same way, so what we render matches what Meta is sent.
 */
export function templateBodyParams(
  templateParams?: string[] | null,
  templateMessageParams?: unknown
): string[] {
  const structured =
    templateMessageParams &&
    typeof templateMessageParams === 'object' &&
    Array.isArray((templateMessageParams as { body?: unknown }).body)
      ? ((templateMessageParams as { body: unknown[] }).body.filter(
          (v): v is string => typeof v === 'string'
        ) as string[])
      : null;

  if (structured && structured.length > 0) return structured;
  return Array.isArray(templateParams) ? templateParams : [];
}

/** A non-empty string, or undefined: what a structured param may hold. */
function textParam(messageParams: unknown, key: string): string | undefined {
  const value =
    messageParams && typeof messageParams === 'object'
      ? (messageParams as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The row a linked-device number (Whapi, OpenWA) renders and sends as an
 * ordinary message: its header text with the header's own value filled in,
 * and its header picture or file where the editor stores it. The composer
 * asks for the header's value and it was then dropped, so the customer
 * read a literal `{{1}}`; and the stored link was never looked at, so a
 * template with a picture went out without it.
 */
export function renderedForLinkedDevice(
  template: MessageTemplate,
  messageParams?: unknown
): MessageTemplate {
  if (template.header_type === 'text') {
    const value = textParam(messageParams, 'headerText');
    return value && template.header_content
      ? {
          ...template,
          header_content: renderTemplateBody(template.header_content, [value]),
        }
      : template;
  }
  const link =
    textParam(messageParams, 'headerMediaUrl') ?? template.header_media_url;
  return link && !template.header_content
    ? { ...template, header_content: link }
    : template;
}

/** `en_US` → `en`; used to match a request against a synced row. */
function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[_-]/)[0];
}

interface TemplateCandidate {
  id?: string;
  language?: string;
  status?: string | null;
  meta_template_id?: string | null;
  submission_error?: string | null;
  created_at?: string | null;
}

/**
 * Which of two rows with the same name and language is the template: the
 * unique key is per user, so two teammates can each hold one. Meta's own
 * approved one first, then one marked approved (a refusal of Meta's last,
 * a save marks those approved too), then the newest.
 */
function templateRank(row: TemplateCandidate): number {
  if (row.status !== 'APPROVED') return 3;
  if (row.meta_template_id) return 0;
  return row.submission_error ? 2 : 1;
}

function byPreference(a: TemplateCandidate, b: TemplateCandidate): number {
  return (
    templateRank(a) - templateRank(b) ||
    Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '') ||
    0
  );
}

export interface ResolvedTemplate {
  /** Best-matching local row, or null when the account has none. */
  row: MessageTemplate | null;
  /**
   * True when a row matched by name but failed the shape guard. Callers
   * surface their own error type — a malformed row would otherwise
   * crash deep inside the send-builder with an opaque TypeError.
   */
  malformed: boolean;
  /**
   * The language code to send to Meta: the caller's when they named
   * one, otherwise the matched row's, otherwise `en_US`. Callers that
   * pinned `en_US` unconditionally could not send an `en` template at
   * all — Meta rejects the pair as a missing translation.
   */
  language: string;
}

/**
 * Look up the `message_templates` row for a send, tolerant of the
 * `en` / `en_US` split.
 *
 * The old lookup was `.eq('language', requested || 'en_US')`. Templates
 * synced from Meta commonly carry the bare `en`, so a caller that
 * omitted the language matched no row: no header components, and no
 * body to persist. Matching falls back through
 * exact → same base language → a sensible default. Among rows of one
 * language, `byPreference`. `templateId` is the row a person chose: when
 * it is this account's and has this name, it is the one, in its own
 * language.
 */
export async function resolveTemplateRow(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  requestedLanguage?: string | null,
  templateId?: string | null
): Promise<ResolvedTemplate> {
  const { data } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName);

  // Sorted here rather than with `.order()` so the only query-builder
  // surface this helper depends on is select + eq — the same shape the
  // callers' existing fakes implement.
  const rows = ((Array.isArray(data) ? data : []) as TemplateCandidate[])
    .slice()
    .sort(
      (a, b) =>
        (a.language ?? '').localeCompare(b.language ?? '') || byPreference(a, b)
    );
  const fallbackLanguage = requestedLanguage || 'en_US';

  if (rows.length === 0) {
    return { row: null, malformed: false, language: fallbackLanguage };
  }

  const pick = (): TemplateCandidate | undefined => {
    if (requestedLanguage) {
      const wanted = requestedLanguage.toLowerCase();
      const exact = rows.find((r) => r.language?.toLowerCase() === wanted);
      if (exact) return exact;
      const wantedBase = baseLanguage(requestedLanguage);
      return rows.find(
        (r) => r.language && baseLanguage(r.language) === wantedBase
      );
    }
    // No language asked for: prefer the historical default, then the
    // bare form, then whatever exists.
    return (
      rows.find((r) => r.language === 'en_US') ??
      rows.find((r) => r.language === 'en') ??
      rows[0]
    );
  };

  const byId = templateId ? rows.find((r) => r.id === templateId) : undefined;
  const chosen = byId ?? pick();
  if (!chosen) {
    // Rows exist but none in the requested language — the caller pinned
    // a translation this account doesn't have. Report no row; under
    // Whapi the local row is the message, so there is nothing to send.
    return { row: null, malformed: false, language: fallbackLanguage };
  }

  if (!isMessageTemplate(chosen)) {
    return { row: null, malformed: true, language: fallbackLanguage };
  }

  return {
    row: chosen,
    malformed: false,
    language:
      (byId ? chosen.language : null) ||
      requestedLanguage ||
      chosen.language ||
      'en_US',
  };
}

/**
 * The text to persist as `messages.content_text` for a template send.
 *
 * `callerText` wins when supplied — the dashboard composer renders the
 * body client-side and posts it, and it knows about header/button
 * values this function doesn't. Otherwise the body is rendered from the
 * local row. Null only when the account has no local copy of the
 * template, which is the one case where we genuinely don't know what
 * the customer saw.
 */
export function templateContentText(
  row: MessageTemplate | null,
  params: string[],
  callerText?: string | null
): string | null {
  if (callerText) return callerText;
  if (!row?.body_text) return null;
  return renderTemplateBody(row.body_text, params);
}
