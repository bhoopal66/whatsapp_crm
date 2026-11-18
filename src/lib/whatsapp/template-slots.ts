import type { MessageTemplate } from '@/types';
import {
  extractVariableIndices,
  extractVariableKeys,
} from '@/lib/whatsapp/template-validators';

export interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

export interface TemplateVariableSlots {
  /**
   * Body variable keys in the order the send lists their values:
   * positional (`"1"`) and named (`"customer_name"`) alike. Must match
   * the server's `extractVariableKeys` in `template-send-builder.ts`:
   * a picker that counted only `{{1}}` sent a named template with no
   * values, and Meta's send builder refused it ("Body has 1 variable(s)
   * but only 0 value(s) were supplied").
   */
  bodyKeys: string[];
  /** Text-header variables (the server reads only `{{1}}` there). */
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
}

/** Every value a person must type before a template can be sent. */
export function collectTemplateVariableSlots(
  template: Pick<
    MessageTemplate,
    'body_text' | 'header_type' | 'header_content' | 'buttons'
  >
): TemplateVariableSlots {
  const bodyKeys = extractVariableKeys(template.body_text ?? '');
  const headerVarCount =
    template.header_type === 'text' && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === 'URL' && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyKeys, headerVarCount, urlButtonSlots };
}
