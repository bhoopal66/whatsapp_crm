// "Submit to Meta" on a saved row (Settings → Templates): which rows it
// is for, which cannot go as they are, and what is sent.

import type { MessageTemplate } from '@/types';

import type { TemplatePayload } from './template-validators';

/** Statuses a row gets here without Meta; the rest are Meta's verdict. */
const LOCAL_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'APPROVED']);

/** Kept only here: Meta has neither an id nor a verdict for it. */
export function isLocalTemplate(row: {
  meta_template_id?: string | null;
  status?: string | null;
}): boolean {
  return !row.meta_template_id && LOCAL_STATUSES.has(row.status ?? 'DRAFT');
}

/**
 * Meta takes a media header only as an uploaded file's handle, which the
 * submit route does not make, and an authentication template only in its
 * own shape: both are made in WhatsApp Manager.
 */
export type TemplateSubmitBlock = 'media_header' | 'authentication';

export function templateSubmitBlock(
  row: Pick<MessageTemplate, 'category' | 'header_type'>
): TemplateSubmitBlock | null {
  if (row.category === 'Authentication') return 'authentication';
  return row.header_type && row.header_type !== 'text' ? 'media_header' : null;
}

/** The row's own content, for POST templates/submit. */
export function templateRowPayload(
  row: MessageTemplate
): TemplatePayload & { template_id: string } {
  return {
    template_id: row.id,
    name: row.name,
    category: row.category,
    language: row.language || 'en_US',
    header_type: row.header_type ?? undefined,
    header_content: row.header_content ?? undefined,
    header_media_url: row.header_media_url ?? undefined,
    body_text: row.body_text,
    footer_text: row.footer_text ?? undefined,
    buttons: row.buttons?.length ? row.buttons : undefined,
    sample_values: row.sample_values ?? undefined,
  };
}
