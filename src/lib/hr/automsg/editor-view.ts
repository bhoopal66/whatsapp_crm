/**
 * Pure view logic for the template editors on the HR Automated messages
 * screen. One editor per kind x language; the database decides every
 * save (`hr_automsg_template_set` re-checks the caller and the body),
 * this only decides what the editor shows and offers. Client components
 * import this file: it imports only this folder's client-safe modules.
 */
import type { AutoMsgTemplateView } from './api';
import { RCS_TEMPLATE_ID, channelOf, type AutomsgChannel } from './channel';
import {
  MAX_TEMPLATE_BODY,
  SEED_TEMPLATES,
  placeholders,
  promotionalPhrase,
  requiredPlaceholders,
  validateTemplateBody,
} from './templates';
import {
  AUTO_LANGS,
  TEMPLATE_KINDS,
  type ApprovalStatus,
  type AutoLang,
  type TemplateCategory,
  type TemplateKind,
} from './types';
import type { AutomsgRole } from './view';

export interface EditorForm {
  body: string;
  metaTemplateName: string;
  approvalStatus: ApprovalStatus;
  category: TemplateCategory;
}

export interface EditorSlot {
  kind: TemplateKind;
  language: AutoLang;
  channel: AutomsgChannel;
  /** The stored row, or null when the seed text stands in for it. */
  stored: AutoMsgTemplateView | null;
  /**
   * React key: changes only when the stored row changes, so an editor is
   * re-initialised after a save but never while someone is typing.
   */
  key: string;
  initial: EditorForm;
}

/**
 * The stored row of one kind x language on one channel. The config holds
 * both channels' rows, so a lookup that ignored the channel could put an
 * RCS row (whose name is a provider id) in a WhatsApp editor.
 */
export function storedTemplate(
  templates: readonly AutoMsgTemplateView[],
  kind: TemplateKind,
  language: AutoLang,
  channel: AutomsgChannel = 'whatsapp'
): AutoMsgTemplateView | null {
  return (
    templates.find(
      (t) =>
        t.kind === kind &&
        t.language === language &&
        channelOf(t.channel) === channel
    ) ?? null
  );
}

/**
 * One slot per kind x language of one channel, in TEMPLATE_KINDS then
 * AUTO_LANGS order. RCS slots are keyed `rcs|…`, apart from WhatsApp's.
 */
export function editorSlots(
  templates: readonly AutoMsgTemplateView[],
  channel: AutomsgChannel = 'whatsapp'
): EditorSlot[] {
  const slots: EditorSlot[] = [];
  for (const kind of TEMPLATE_KINDS) {
    for (const language of AUTO_LANGS) {
      const stored = storedTemplate(templates, kind, language, channel);
      const whatsapp =
        channel === 'rcs' ? storedTemplate(templates, kind, language) : null;
      const key = stored
        ? [
            kind,
            language,
            stored.updatedAt ?? '',
            stored.approvalStatus,
            stored.metaTemplateName,
            stored.body,
          ].join('|')
        : channel === 'rcs'
          ? // An unsaved RCS editor starts from the WhatsApp text, so it
            // re-initialises when that row is saved.
            `${kind}|${language}|seed|${whatsapp?.updatedAt ?? ''}`
          : `${kind}|${language}|seed`;
      slots.push({
        kind,
        language,
        channel,
        stored,
        key: channel === 'rcs' ? `rcs|${key}` : key,
        initial: editorInitial(kind, language, stored, channel, whatsapp),
      });
    }
  }
  return slots;
}

/**
 * The stored row's values, else a draft: on WhatsApp the seed text and
 * seed Meta name; on RCS the WhatsApp text of the same kind and language
 * (the stored row, else the seed) and an empty provider id.
 */
export function editorInitial(
  kind: TemplateKind,
  language: AutoLang,
  stored: AutoMsgTemplateView | null,
  channel: AutomsgChannel = 'whatsapp',
  whatsapp: AutoMsgTemplateView | null = null
): EditorForm {
  if (stored) {
    return {
      body: stored.body,
      metaTemplateName: stored.metaTemplateName,
      approvalStatus: stored.approvalStatus,
      category: stored.category,
    };
  }
  const seed = SEED_TEMPLATES[kind];
  if (channel === 'rcs') {
    return {
      body: whatsapp?.body ?? seed.text[language],
      metaTemplateName: '',
      approvalStatus: 'draft',
      category: 'utility',
    };
  }
  return {
    body: seed.text[language],
    metaTemplateName: seed.metaTemplateName,
    approvalStatus: 'draft',
    category: 'utility',
  };
}

/** The counter's values for `templates.counter` ("n / 1024 characters"). */
export function editorCounter(body: string): { count: number; max: number } {
  return { count: body.length, max: MAX_TEMPLATE_BODY };
}

/** Meta's template names: lowercase letters, digits and underscores. */
export const META_TEMPLATE_NAME = /^[a-z0-9_]+$/;

/** A message under the editor: a key under `automsg.templates.check` plus values. */
export type EditorMessage =
  | { key: 'missingPlaceholder'; values: { slot: string } }
  | { key: 'promotional'; values: { phrase: string } }
  | { key: 'tooLong'; values: { max: number } }
  | { key: 'invalid'; values: { name: string; slot: string } }
  | { key: 'nameFormat' }
  | { key: 'approvedNeedsName' }
  | { key: 'rcsApprovedNeedsId' }
  | { key: 'rcsIdFormat' };

/** Every message key, for the label-coverage test. */
export const EDITOR_MESSAGE_KEYS: readonly EditorMessage['key'][] = [
  'missingPlaceholder',
  'promotional',
  'tooLong',
  'invalid',
  'nameFormat',
  'approvedNeedsName',
  'rcsApprovedNeedsId',
  'rcsIdFormat',
];

/**
 * 215's rule on an RCS template's provider id (trimmed, as the save
 * sends it): an approved template needs one, a draft may leave it empty,
 * and a non-empty one must match RCS_TEMPLATE_ID.
 */
export function rcsTemplateIdProblem(
  id: string,
  approvalStatus: ApprovalStatus
): 'rcsApprovedNeedsId' | 'rcsIdFormat' | null {
  const v = id.trim();
  if (v === '')
    return approvalStatus === 'approved' ? 'rcsApprovedNeedsId' : null;
  return RCS_TEMPLATE_ID.test(v) ? null : 'rcsIdFormat';
}

/**
 * Live validation, in display order: the body (missing placeholders by
 * name, else too long, else promotional wording with the phrase, else
 * generically invalid), then the Meta template name, or on RCS the
 * provider template id. Body rules are the same on both channels.
 */
export function editorMessages(
  kind: TemplateKind,
  form: EditorForm,
  channel: AutomsgChannel = 'whatsapp'
): EditorMessage[] {
  const out: EditorMessage[] = [];
  const check = validateTemplateBody(kind, form.body, form.category);
  if (check === 'PROMOTIONAL') {
    out.push({
      key: 'promotional',
      values: { phrase: promotionalPhrase(form.body) ?? '' },
    });
  } else if (check !== 'ok') {
    const used = placeholders(form.body);
    const missing = requiredPlaceholders(kind).filter((p) => !used.includes(p));
    if (missing.length > 0) {
      for (const p of missing)
        out.push({ key: 'missingPlaceholder', values: { slot: `{${p}}` } });
    } else if (form.body.length > MAX_TEMPLATE_BODY) {
      out.push({ key: 'tooLong', values: { max: MAX_TEMPLATE_BODY } });
    } else {
      // The label names the placeholders through values: a literal
      // {name} in an ICU message would be read as an argument.
      out.push({ key: 'invalid', values: { name: '{name}', slot: '{slot}' } });
    }
  }
  if (channel === 'rcs') {
    const problem = rcsTemplateIdProblem(
      form.metaTemplateName,
      form.approvalStatus
    );
    if (problem) out.push({ key: problem });
    return out;
  }
  const name = form.metaTemplateName.trim();
  if (name === '') {
    if (form.approvalStatus === 'approved')
      out.push({ key: 'approvedNeedsName' });
  } else if (!META_TEMPLATE_NAME.test(name)) {
    out.push({ key: 'nameFormat' });
  }
  return out;
}

export interface EditorView {
  /** Leads (and anyone not an admin) see the fields read-only, on both channels. */
  readOnly: boolean;
  counter: { count: number; max: number };
  messages: EditorMessage[];
  canSave: boolean;
}

export function editorView(
  kind: TemplateKind,
  form: EditorForm,
  role: AutomsgRole | null,
  saving = false,
  channel: AutomsgChannel = 'whatsapp'
): EditorView {
  const readOnly = role !== 'admin';
  const messages = editorMessages(kind, form, channel);
  return {
    readOnly,
    counter: editorCounter(form.body),
    messages,
    canSave: !readOnly && !saving && messages.length === 0,
  };
}

/**
 * The save payload: the name trimmed, everything else as typed. An RCS
 * save names its channel; a WhatsApp one leaves it out (the RPC's
 * default), exactly as before RCS existed.
 */
export function editorPayload(
  kind: TemplateKind,
  language: AutoLang,
  form: EditorForm,
  channel: AutomsgChannel = 'whatsapp'
): {
  kind: TemplateKind;
  language: AutoLang;
  body: string;
  metaTemplateName: string;
  approvalStatus: ApprovalStatus;
  category: TemplateCategory;
  channel?: AutomsgChannel;
} {
  return {
    kind,
    language,
    body: form.body,
    metaTemplateName: form.metaTemplateName.trim(),
    approvalStatus: form.approvalStatus,
    category: form.category,
    ...(channel === 'rcs' ? { channel } : {}),
  };
}
