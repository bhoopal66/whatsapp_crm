/**
 * The reverse of `template-components.ts`: a template as Meta's registry
 * describes it → the local `message_templates` row shape. Pure, so the
 * sync route stays a thin loop and the mapping is unit-tested.
 */

import type { MetaTemplateRecord } from './meta-api';
import type {
  MessageTemplate,
  MessageTemplateStatus,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';

const CATEGORY_FROM_META: Record<string, MessageTemplate['category']> = {
  MARKETING: 'Marketing',
  UTILITY: 'Utility',
  AUTHENTICATION: 'Authentication',
};

const HEADER_TYPE_FROM_META: Record<
  string,
  NonNullable<MessageTemplate['header_type']>
> = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
};

const KNOWN_STATUSES: ReadonlySet<string> = new Set<MessageTemplateStatus>([
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
]);

/** Columns the sync writes. `user_id` is added by the route. */
export interface ImportedTemplateRow {
  name: string;
  language: string;
  category: MessageTemplate['category'];
  header_type: MessageTemplate['header_type'] | null;
  header_content: string | null;
  body_text: string;
  footer_text: string | null;
  buttons: TemplateButton[] | null;
  sample_values: TemplateSampleValues | null;
  status: MessageTemplateStatus;
  meta_template_id: string;
  quality_score: 'GREEN' | 'YELLOW' | 'RED' | null;
}

function toButton(
  b: NonNullable<MetaTemplateRecord['components'][number]['buttons']>[number]
): TemplateButton | null {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL':
      if (!b.url) return null;
      return b.example?.[0]
        ? { type: 'URL', text: b.text, url: b.url, example: b.example[0] }
        : { type: 'URL', text: b.text, url: b.url };
    case 'PHONE_NUMBER':
      if (!b.phone_number) return null;
      return {
        type: 'PHONE_NUMBER',
        text: b.text,
        phone_number: b.phone_number,
      };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: b.example?.[0] ?? '' };
    default:
      // OTP, catalog, flow and other button kinds have no local
      // equivalent; drop them rather than store something the send
      // builder can't render.
      return null;
  }
}

/**
 * Map one Meta template to a local row, or `null` when it has no BODY
 * (a template the CRM could never render or send). Categories and
 * statuses outside the local enums fall back to sendable defaults:
 * an unknown category becomes Marketing — the safe assumption for a
 * campaign tool — and an unknown status is stored as-is only if the
 * CHECK constraint allows it, else PENDING.
 */
export function metaTemplateToRow(
  t: MetaTemplateRecord
): ImportedTemplateRow | null {
  const body = t.components.find((c) => c.type === 'BODY');
  if (!body?.text) return null;

  const header = t.components.find((c) => c.type === 'HEADER');
  const footer = t.components.find((c) => c.type === 'FOOTER');
  const buttons = t.components.find((c) => c.type === 'BUTTONS');

  const headerType = header?.format
    ? (HEADER_TYPE_FROM_META[header.format] ?? null)
    : null;

  const sample: TemplateSampleValues = {};
  if (body.example?.body_text?.[0]?.length) {
    sample.body = body.example.body_text[0];
  }
  if (header?.example?.header_text?.length) {
    sample.header = header.example.header_text;
  }

  const mapped = (buttons?.buttons ?? [])
    .map(toButton)
    .filter((b): b is TemplateButton => b !== null);

  const quality = t.quality_score?.score;

  return {
    name: t.name,
    language: t.language,
    category: CATEGORY_FROM_META[t.category] ?? 'Marketing',
    header_type: headerType,
    header_content: headerType === 'text' ? (header?.text ?? null) : null,
    body_text: body.text,
    footer_text: footer?.text ?? null,
    buttons: mapped.length > 0 ? mapped : null,
    sample_values: Object.keys(sample).length > 0 ? sample : null,
    status: KNOWN_STATUSES.has(t.status)
      ? (t.status as MessageTemplateStatus)
      : 'PENDING',
    meta_template_id: t.id,
    quality_score:
      quality === 'GREEN' || quality === 'YELLOW' || quality === 'RED'
        ? quality
        : null,
  };
}
