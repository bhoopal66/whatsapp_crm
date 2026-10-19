/**
 * The hand-over message a supervisor's Take over sends to the customer
 * (module 018c, CaseConversations.takeOver; migration 128 logs it).
 *
 * HANDOVER_TEMPLATE_DRAFT is a DRAFT — NOT APPROVED, REQUIRES LEGAL
 * REVIEW. takeOver refuses it (TEMPLATE_NOT_APPROVED) unless the deps pass
 * allowDraftTemplate: true (tests only); production wiring must supply an
 * APPROVED template instead.
 *
 * renderHandover fills ONLY {agentName} and {bankName}, through a replacer
 * function so a "$" in a name is inserted literally (no String.replace
 * $-pattern interpretation). validateHandover normalises and checks the
 * names and the version BEFORE anything is logged.
 */

export interface HandoverTemplate {
  /** Recorded in case_takeover_log.template_version (1-40 chars). */
  version: string;
  /** DRAFT templates are refused unless allowDraftTemplate is set. */
  status: 'APPROVED' | 'DRAFT';
  text: string;
}

export interface HandoverVars {
  agentName: string;
  bankName: string;
}

/** DRAFT — NOT APPROVED. Must not reach a customer until legal signs off. */
export const HANDOVER_TEMPLATE_DRAFT: HandoverTemplate = Object.freeze({
  version: 'draft-1',
  status: 'DRAFT',
  text:
    'Hello, this is {agentName}. I am now looking after your application with {bankName} and will be your contact ' +
    'from here. You can reply to me in this chat. As before, conversations are reviewed for quality and compliance.',
});

export const HANDOVER_MAX_NAME_LEN = 100;
/** 128's case_takeover_log_version_check. */
export const HANDOVER_MAX_VERSION_LEN = 40;

/** Every whitespace / C0 / C1 control run becomes one space; trimmed. */
const CONTROL_RUN = /[\s\u0000-\u001f\u007f-\u009f]+/g;
export const oneLine = (s: string): string =>
  s.replace(CONTROL_RUN, ' ').trim();

const PLACEHOLDER = /\{(agentName|bankName)\}/g;

export function renderHandover(
  template: HandoverTemplate,
  vars: HandoverVars
): string {
  return template.text.replace(
    PLACEHOLDER,
    (_m, key: keyof HandoverVars) => vars[key]
  );
}

export type HandoverInvalid = 'TEMPLATE_INVALID' | 'NAME_INVALID';

/**
 * The normalised version and rendered text, or why not: the version must be
 * 1-40 characters and the text non-blank (TEMPLATE_INVALID); each name
 * 1-100 characters after normalising (NAME_INVALID).
 */
export function validateHandover(
  template: HandoverTemplate,
  vars: HandoverVars
):
  | { ok: true; version: string; text: string }
  | { ok: false; reason: HandoverInvalid } {
  const version = oneLine(template.version ?? '');
  if (
    version === '' ||
    version.length > HANDOVER_MAX_VERSION_LEN ||
    oneLine(template.text ?? '') === ''
  )
    return { ok: false, reason: 'TEMPLATE_INVALID' };
  const agentName = oneLine(vars.agentName ?? '');
  const bankName = oneLine(vars.bankName ?? '');
  for (const v of [agentName, bankName])
    if (v === '' || v.length > HANDOVER_MAX_NAME_LEN)
      return { ok: false, reason: 'NAME_INVALID' };
  return {
    ok: true,
    version,
    text: renderHandover(template, { agentName, bankName }),
  };
}
