// ============================================================
// Compass notifications on the Meta number: the 24-hour service window
// and the approved templates. Pure, so the Compass templates tab and
// the send path judge the same way.
//
// Meta allows free text only within 24 hours of the customer's last
// message to the number. Outside that window a Compass update goes as
// the Meta-approved template that says the same thing: one template per
// Compass event, worded exactly as the message Compass sends, with the
// company and the bank as its variables. Those two values are read back
// out of Compass's own text, so what the customer reads is the same
// either way. A message no template matches is not sent outside the
// window.
// ============================================================

import { extractVariableKeys } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

/**
 * How long after the customer's last message free text is still sent.
 * Ten minutes short of Meta's 24 hours, so a send that is slow to reach
 * Meta is never refused for being a few seconds late.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60_000 - 10 * 60_000;

/** True when a customer message at `lastInboundAt` still allows free text. */
export function serviceWindowOpen(
  lastInboundAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!lastInboundAt) return false;
  const at = Date.parse(lastInboundAt);
  if (Number.isNaN(at)) return false;
  return now - at < SERVICE_WINDOW_MS;
}

const CONTACT_BLOCK =
  'Should you have any questions, please contact us:\n' +
  'Phone: +971 4 550 2800\n' +
  'Email: info@taamulcredit.com\n' +
  'Website: https://taamulcredit.com\n\n' +
  'Kind regards,\n' +
  '*Taamul Credit Review Services*';

export interface CompassTemplate {
  /** The Compass `event` this template stands in for. */
  event: string;
  /** Name and language in the WABA registry and `message_templates`. */
  name: string;
  language: string;
  /** Body as submitted to Meta: {{1}} company, {{2}} bank. */
  body: string;
  /** Example values Meta reviews the template with. */
  sample: [string, string];
  /** [company, bank] read out of Compass's text, or null when it differs. */
  parse: (text: string) => [string, string] | null;
}

/** Normalise line endings and trailing spaces before matching. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Reads the two values out of `text` when it is exactly `body` with
 * them filled in (line endings and trailing spaces aside). Exact, so a
 * message Compass rewords is never sent as the old wording.
 */
function parserFor(body: string): CompassTemplate['parse'] {
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    '^' +
      escaped
        .replace('\\{\\{1\\}\\}', '([^\\n]+?)')
        .replace('\\{\\{2\\}\\}', '([^\\n]+?)') +
      '$'
  );
  return (text) => {
    const m = tidy(text).match(pattern);
    if (!m) return null;
    const company = m[1].trim();
    const bank = m[2].trim();
    return company && bank ? [company, bank] : null;
  };
}

function template(t: Omit<CompassTemplate, 'parse'>): CompassTemplate {
  return { ...t, parse: parserFor(t.body) };
}

/** The approved templates, one per Compass event. */
export const COMPASS_TEMPLATES: readonly CompassTemplate[] = [
  template({
    event: 'case.submitted',
    name: 'compass_case_submitted',
    language: 'en',
    body:
      'Dear {{1}},\n\n' +
      'Thank you for choosing Taamul Credit Review Services. We are pleased to confirm that your bank account application has been submitted to {{2}}.\n\n' +
      'We will keep you informed of its progress and will notify you as soon as the bank responds.\n\n' +
      CONTACT_BLOCK,
    sample: ['PREMIER LUBRICANTS FACTORY L.L.C', 'MASHREQ'],
  }),
  template({
    event: 'case.approved',
    name: 'compass_case_approved',
    language: 'en',
    body:
      'Dear {{1}},\n\n' +
      'We are pleased to inform you that your bank account application with {{2}} has been *approved*.\n\n' +
      'A member of our team will contact you shortly to guide you through the next steps.\n\n' +
      CONTACT_BLOCK,
    sample: ['AL KHAYRAT FURNITURE & DECOR IND. FACTORY LLC.', 'NBF'],
  }),
];

/**
 * The template an update goes as outside the window, with its values:
 * the event's template when the text matches it. Only an update sent
 * without an event is matched against every template; an event with no
 * template of its own matches none. Null when nothing matches.
 */
export function compassTemplateFor(
  event: string | null,
  text: string | null
): { template: CompassTemplate; params: [string, string] } | null {
  if (!text) return null;
  const candidates =
    event === null
      ? COMPASS_TEMPLATES
      : COMPASS_TEMPLATES.filter((t) => t.event === event);
  for (const t of candidates) {
    const params = t.parse(text);
    if (params) return { template: t, params };
  }
  return null;
}

export type CompassTemplateProblem = 'missing' | 'not_approved' | 'changed';

/**
 * Why the local `message_templates` row cannot carry the update, or
 * null when it can: it must exist, be approved by Meta, and still hold
 * the body the values were read against (two variables, same wording).
 */
export function compassTemplateProblem(
  template: CompassTemplate,
  row: Pick<MessageTemplate, 'status' | 'body_text'> | null
): CompassTemplateProblem | null {
  if (!row) return 'missing';
  if (String(row.status ?? '').toUpperCase() !== 'APPROVED') {
    return 'not_approved';
  }
  if (
    tidy(row.body_text ?? '') !== tidy(template.body) ||
    new Set(extractVariableKeys(row.body_text ?? '')).size !== 2
  ) {
    return 'changed';
  }
  return null;
}
