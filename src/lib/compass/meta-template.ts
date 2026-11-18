// ============================================================
// Compass notifications on the Meta number (migration 209): the
// 24-hour service window and the fallback template. Pure, so the
// Compass settings screen and the send path judge a template the same
// way.
//
// Meta allows free text only within 24 hours of the customer's last
// message to the number. Outside that window an update goes as one
// approved utility template with the Compass text in its single body
// variable. Meta refuses a body variable that holds a line break, a
// tab or more than four spaces in a row, so the text is flattened onto
// one line.
// ============================================================

import { extractVariableKeys } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

/**
 * How long after the customer's last message free text is still sent.
 * Ten minutes short of Meta's 24 hours, so a send that is slow to reach
 * Meta is never refused for being a few seconds late.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60_000 - 10 * 60_000;

/** Meta's limit on a template body, with the variable filled in. */
export const TEMPLATE_BODY_MAX = 1024;

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

export type CompassTemplateProblem =
  'not_approved' | 'not_utility' | 'one_variable' | 'header' | 'buttons';

export type CompassTemplateFields = Pick<
  MessageTemplate,
  'status' | 'category' | 'body_text' | 'header_type' | 'header_content'
> & { buttons?: MessageTemplate['buttons'] | null };

/**
 * Why a template cannot carry Compass updates, or null when it can.
 * It must be approved by Meta, a utility template (an account update,
 * not marketing), with exactly one body variable for the text, and
 * nothing else that needs a value at send time: no media header, no
 * header variable, no URL variable or copy-code button.
 */
export function compassTemplateProblem(
  row: CompassTemplateFields
): CompassTemplateProblem | null {
  if (String(row.status ?? '').toUpperCase() !== 'APPROVED') {
    return 'not_approved';
  }
  if (String(row.category ?? '').toLowerCase() !== 'utility') {
    return 'not_utility';
  }
  if (new Set(extractVariableKeys(row.body_text ?? '')).size !== 1) {
    return 'one_variable';
  }
  if (row.header_type && row.header_type !== 'text') return 'header';
  if (
    row.header_type === 'text' &&
    extractVariableKeys(row.header_content ?? '').length > 0
  ) {
    return 'header';
  }
  const buttons = Array.isArray(row.buttons) ? row.buttons : [];
  if (
    buttons.some(
      (b) => b.type === 'COPY_CODE' || (b.type === 'URL' && /\{\{/.test(b.url))
    )
  ) {
    return 'buttons';
  }
  return null;
}

/** The Compass text as one body variable Meta accepts: one line, no runs of spaces. */
export function compassTemplateParam(text: string): string {
  // Every whitespace run (line breaks, tabs, U+2028, repeated spaces)
  // becomes one space.
  return text.replace(/\s+/g, ' ').trim();
}
