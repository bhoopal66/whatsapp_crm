/**
 * Pure view logic for the template editors on the HR Automated messages
 * screen. One editor per kind x language; the database decides every
 * save (`hr_automsg_template_set` re-checks the caller and the body),
 * this only decides what the editor shows and offers. Client components
 * import this file: it imports only this folder's client-safe modules.
 */
import type { AutoMsgTemplateView } from './api';
import {
  RCS_TEMPLATE_ID,
  SMS_TEMPLATE_LABEL,
  channelOf,
  type AutomsgChannel,
} from './channel';
import { measureSms, type SmsMeasure } from './sms-text';
import {
  MAX_TEMPLATE_BODY,
  SEED_TEMPLATES,
  SLOT_FALLBACK,
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
   * Changes only when the stored row changes: what `followSlot` compares
   * to tell whether an editor still shows what is stored.
   */
  key: string;
  initial: EditorForm;
}

/** One editor: the slot it was filled from, and the form as typed. */
export interface EditorState {
  base: EditorSlot;
  form: EditorForm;
}

/**
 * The editor after a reload: an untouched one shows what is stored now, a
 * touched one keeps its text and the version it was read with.
 */
export function followSlot(state: EditorState, slot: EditorSlot): EditorState {
  if (slot.key === state.base.key) return state;
  const { form, base } = state;
  const touched = (Object.keys(form) as (keyof EditorForm)[]).some(
    (k) => form[k] !== base.initial[k]
  );
  return touched ? state : { base: slot, form: slot.initial };
}

/** Somebody saved the stored row after the editor was filled. */
export function storedMoved(base: EditorSlot, slot: EditorSlot): boolean {
  return (base.stored?.updatedAt ?? null) !== (slot.stored?.updatedAt ?? null);
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
 * AUTO_LANGS order. RCS and SMS slots are keyed `rcs|…` / `sms|…`, apart
 * from WhatsApp's.
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
        channel !== 'whatsapp'
          ? storedTemplate(templates, kind, language)
          : null;
      const key = stored
        ? [
            kind,
            language,
            stored.updatedAt ?? '',
            stored.approvalStatus,
            stored.metaTemplateName,
            stored.body,
          ].join('|')
        : channel !== 'whatsapp'
          ? // An unsaved RCS or SMS editor starts from the WhatsApp text,
            // so it re-initialises when that row is saved.
            `${kind}|${language}|seed|${whatsapp?.updatedAt ?? ''}`
          : `${kind}|${language}|seed`;
      slots.push({
        kind,
        language,
        channel,
        stored,
        key: channel !== 'whatsapp' ? `${channel}|${key}` : key,
        initial: editorInitial(kind, language, stored, channel, whatsapp),
      });
    }
  }
  return slots;
}

/**
 * The stored row's values, else a draft: on WhatsApp the seed text and
 * seed Meta name; on RCS and SMS the WhatsApp text of the same kind and
 * language (the stored row, else the seed) and an empty provider id or
 * label.
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
  if (channel !== 'whatsapp') {
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
  | { key: 'rcsIdFormat' }
  | { key: 'smsApprovedNeedsLabel' }
  | { key: 'smsLabelFormat' };

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
  'smsApprovedNeedsLabel',
  'smsLabelFormat',
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
 * 226's rule on an SMS template's label (trimmed, as the save sends it):
 * an approved template needs one (203's approved_named constraint), a
 * draft may leave it empty, and a non-empty one must match
 * SMS_TEMPLATE_LABEL.
 */
export function smsLabelProblem(
  label: string,
  approvalStatus: ApprovalStatus
): 'smsApprovedNeedsLabel' | 'smsLabelFormat' | null {
  const v = label.trim();
  if (v === '')
    return approvalStatus === 'approved' ? 'smsApprovedNeedsLabel' : null;
  return SMS_TEMPLATE_LABEL.test(v) ? null : 'smsLabelFormat';
}

/** The name length the SMS counter assumes; longer names add characters. */
export const SMS_NAME_ALLOWANCE = 20;

/**
 * The SMS counter: the body as the engine would send it, with {slot} as
 * the engine fills it today (SLOT_FALLBACK) and {name} as a name of
 * SMS_NAME_ALLOWANCE plain letters. Measuring the raw body would count
 * every template as Unicode, because '{' is outside the GSM alphabet.
 */
export function smsBodyMeasure(body: string): SmsMeasure {
  return measureSms(
    body
      .replaceAll('{slot}', SLOT_FALLBACK)
      .replaceAll('{name}', 'N'.repeat(SMS_NAME_ALLOWANCE))
  );
}

/**
 * Live validation, in display order: the body (missing placeholders by
 * name, else too long, else promotional wording with the phrase, else
 * generically invalid), then the Meta template name, on RCS the provider
 * template id, on SMS the label. Body rules are the same on every channel;
 * an SMS over 3 segments is shown by the counter (`EditorView.sms`), not
 * refused here, because the candidate's name decides the final length.
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
  if (channel === 'sms') {
    const problem = smsLabelProblem(form.metaTemplateName, form.approvalStatus);
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
  /** SMS only: characters, segments and encoding as it would be sent. */
  sms: SmsMeasure | null;
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
    sms: channel === 'sms' ? smsBodyMeasure(form.body) : null,
    messages,
    canSave: !readOnly && !saving && messages.length === 0,
  };
}

/**
 * The save payload: the name trimmed, everything else as typed. An RCS or
 * SMS save names its channel; a WhatsApp one leaves it out (the RPC's
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
    ...(channel !== 'whatsapp' ? { channel } : {}),
  };
}
