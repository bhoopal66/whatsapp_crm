// The templates a deal room's group may be sent once its 24-hour window is
// closed. The group is always on the Meta number, and the send names the
// template to Meta without a local row (`sendGroupTemplate`), so only one
// Meta has (a row with its id) can be picked.

import {
  templateOptions,
  type TemplateBlock,
  type TemplateOption,
} from '@/lib/whatsapp/template-offer';
import type { MessageTemplateStatus } from '@/types';

export interface RoomTemplateRow {
  id: string;
  name: string;
  language: string;
  body_text: string | null;
  status?: MessageTemplateStatus;
  meta_template_id?: string;
  submission_error?: string;
  created_at?: string;
}

/** `not_linked`: marked approved here, but not known to be at Meta. */
export type RoomTemplateBlock = TemplateBlock | 'not_linked';

export function roomTemplateOptions(
  rows: readonly RoomTemplateRow[]
): TemplateOption<RoomTemplateRow, RoomTemplateBlock>[] {
  const options = templateOptions(rows, 'meta').map(({ template, reason }) => ({
    template,
    reason: reason ?? (template.meta_template_id ? null : 'not_linked'),
  })) satisfies TemplateOption<RoomTemplateRow, RoomTemplateBlock>[];
  // The ones that can be picked first.
  return [
    ...options.filter((o) => !o.reason),
    ...options.filter((o) => o.reason),
  ];
}
