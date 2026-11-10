/**
 * WhatsApp "tap to classify" document intake (migration 183).
 *
 * When a customer sends a document into a case's submission group, the
 * coordinator's number answers with a numbered list of the documents the
 * case still needs; the customer's bare-number reply classifies the file
 * and runs its checks, and the group hears the result.
 *
 * The logic here is pure over `IntakePorts`; the Supabase adapter and the
 * webhook wiring live elsewhere. Rules:
 *
 * - Nothing happens unless `files_intake_prompts` is on and the wording is
 *   approved. Every refusal that can be known before a write (switch off,
 *   wording unapproved, case closed, no coordinator, a group without
 *   WhatsApp) returns BEFORE `register`: a prompt that cannot be sent
 *   writes nothing.
 * - The prompt is recorded only after the send went out (a "sent but not
 *   recorded" send counts as sent); any other send failure records nothing,
 *   so a reply can never answer a prompt the customer never saw.
 * - Never throws: every port call is caught. Logs carry ids and codes only,
 *   never message text or file names.
 */

/** Wording keys; each is used only while its template is approved. */
export type IntakeTemplateKind =
  'classify' | 'document_rejected' | 'document_received_next';

/** SQL caps a prompt's options (migration 183 refuses more). */
export const MAX_INTAKE_OPTIONS = 20;

export interface IntakeCaseInfo {
  accountId: string;
  groupId: string | null;
  coordinatorId: string | null;
  closedAt: Date | string | null;
  /**
   * 134's lock (`isManagedExternally`): Compass manages the case, so the
   * intake neither registers, prompts nor classifies (181's header).
   */
  managedExternally: boolean;
}

/** One row of the case's merged spec/checklist, with its requirement label. */
export interface IntakeChecklistRow {
  docKey: string;
  position: number;
  required: boolean;
  label: string | null;
}

export interface IntakeOption {
  n: number;
  docKey: string;
  label: string;
}

export interface IntakePrompt {
  id: string;
  fileId: string;
  options: readonly IntakeOption[];
}

/**
 * A send that went out (`recorded: false` = sent, not settled), or one that
 * did not (`code` names the refusal). A thrown send counts as not sent.
 */
export type IntakeSendResult =
  { sent: true; recorded: boolean } | { sent: false; code: string };

export interface IntakeCheckResult {
  status: 'passed' | 'failed';
  checks: readonly { name: string; ok: boolean }[];
}

export interface IntakePorts {
  caseInfo(caseId: string): Promise<IntakeCaseInfo | null>;
  /** `case_files_settings(account).intakePrompts`. */
  intakeEnabled(accountId: string): Promise<boolean>;
  /** The approved body, or null while the wording is not approved. */
  approvedTemplate(
    accountId: string,
    kind: IntakeTemplateKind
  ): Promise<string | null>;
  /** The submission group's `wa_mode`, null when the group is gone. */
  groupMode(groupId: string): Promise<'group' | 'none' | null>;
  /** `CaseFilesStore.register(null, …)`: idempotent; returns the file id. */
  register(caseId: string, customerDocumentId: string): Promise<string>;
  checklist(caseId: string): Promise<IntakeChecklistRow[]>;
  /** Doc keys that already have a file with status 'passed'. */
  passedDocKeys(caseId: string): Promise<string[]>;
  /** Sends into the case's group as the coordinator (send limit included). */
  send(input: {
    accountId: string;
    caseId: string;
    groupId: string;
    coordinatorId: string;
    text: string;
  }): Promise<IntakeSendResult>;
  recordPrompt(input: {
    caseId: string;
    fileId: string;
    options: readonly IntakeOption[];
    now: Date;
  }): Promise<void>;
  openPrompt(caseId: string): Promise<IntakePrompt | null>;
  /** Claims the prompt once; throws a refusal (`reason` / `hint`) otherwise. */
  answerPrompt(input: {
    promptId: string;
    choice: number;
    now: Date;
  }): Promise<{ fileId: string; docKey: string }>;
  /** `classifyAndCheck` with actor NULL. */
  classifyAndCheck(input: {
    fileId: string;
    docKey: string;
    today: string;
  }): Promise<IntakeCheckResult>;
  fileReady(caseId: string): Promise<boolean>;
  /** Ids and codes only. Defaults to `console.warn`. */
  log?(event: string, fields: Record<string, string | number | null>): void;
}

export type IntakeOutcome =
  | 'off'
  | 'not_approved'
  | 'no_case'
  | 'case_closed'
  | 'no_sender'
  | 'no_group'
  | 'no_options'
  | 'not_sent'
  | 'prompted'
  | 'not_an_answer'
  | 'no_prompt'
  | 'answer_refused'
  | 'rejected'
  | 'received'
  | 'ready'
  | 'error';

const DEFAULT_FILE = 'your document';

/** A label, else the doc key with '_' read as a space. */
export function intakeLabel(docKey: string, label: string | null): string {
  const l = label?.trim();
  return l ? l : docKey.replace(/_/g, ' ');
}

/**
 * The required documents still missing, in position order (doc key breaks
 * a tie), numbered 1..n and capped at `MAX_INTAKE_OPTIONS`.
 */
export function buildIntakeOptions(
  checklist: readonly IntakeChecklistRow[],
  passedDocKeys: readonly string[]
): IntakeOption[] {
  const passed = new Set(passedDocKeys);
  const seen = new Set<string>();
  return checklist
    .filter((r) => r.required && !passed.has(r.docKey))
    .filter((r) => (seen.has(r.docKey) ? false : (seen.add(r.docKey), true)))
    .sort((a, b) => a.position - b.position || a.docKey.localeCompare(b.docKey))
    .slice(0, MAX_INTAKE_OPTIONS)
    .map((r, i) => ({
      n: i + 1,
      docKey: r.docKey,
      label: intakeLabel(r.docKey, r.label),
    }));
}

/** One `N. Label` per line. */
export function renderIntakeList(options: readonly IntakeOption[]): string {
  return options.map((o) => `${o.n}. ${o.label}`).join('\n');
}

/** Single pass: a value that itself contains `{list}` is not expanded. */
export function renderIntakeTemplate(
  body: string,
  values: Readonly<Record<string, string>>
): string {
  return body.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
  );
}

/** A bare integer 1..20 (surrounding whitespace allowed), else null. */
export function parseIntakeChoice(body: string): number | null {
  const t = body.trim();
  if (!/^[0-9]{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_INTAKE_OPTIONS ? n : null;
}

function errorCode(e: unknown): string {
  const x = e as { reason?: unknown; hint?: unknown; code?: unknown };
  for (const v of [x?.reason, x?.hint, x?.code]) {
    if (typeof v === 'string' && v) return v;
  }
  return 'ERROR';
}

type Log = (
  event: string,
  fields: Record<string, string | number | null>
) => void;

function logger(ports: IntakePorts): Log {
  return (event, fields) => {
    try {
      if (ports.log) ports.log(event, fields);
      else console.warn(`[case-intake] ${event}`, fields);
    } catch {
      // logging must never break the intake
    }
  };
}

/** Runs a port call; a throw is logged (code only) and read as `failed`. */
async function attempt<T>(
  log: Log,
  step: string,
  ids: Record<string, string | number | null>,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = errorCode(e);
    log('PORT_FAILED', { step, code, ...ids });
    return { ok: false, code };
  }
}

/** The account and the coordinator a send speaks as, or why there is none. */
type Sender =
  | { ok: true; info: IntakeCaseInfo; coordinatorId: string; groupId: string }
  | { ok: false; outcome: IntakeOutcome };

function senderOf(info: IntakeCaseInfo): Sender {
  if (info.closedAt) return { ok: false, outcome: 'case_closed' };
  if (!info.coordinatorId) return { ok: false, outcome: 'no_sender' };
  if (!info.groupId) return { ok: false, outcome: 'no_group' };
  return {
    ok: true,
    info,
    coordinatorId: info.coordinatorId,
    groupId: info.groupId,
  };
}

async function sendAs(
  ports: IntakePorts,
  log: Log,
  caseId: string,
  sender: Extract<Sender, { ok: true }>,
  text: string
): Promise<IntakeSendResult> {
  const r = await attempt(log, 'send', { caseId }, () =>
    ports.send({
      accountId: sender.info.accountId,
      caseId,
      groupId: sender.groupId,
      coordinatorId: sender.coordinatorId,
      text,
    })
  );
  if (!r.ok) return { sent: false, code: r.code };
  if (!r.value.sent) log('SEND_REFUSED', { caseId, code: r.value.code });
  return r.value;
}

/**
 * A customer's document landed in the case's submission group: register it
 * (actor NULL) and ask which document it is.
 */
export async function onCustomerGroupDocument(
  ports: IntakePorts,
  input: {
    caseId: string;
    groupId: string;
    customerDocumentId: string;
    fileName?: string | null;
    now: Date;
  }
): Promise<IntakeOutcome> {
  const log = logger(ports);
  const { caseId, groupId, customerDocumentId } = input;
  const ids = { caseId, groupId, customerDocumentId };

  const info = await attempt(log, 'caseInfo', ids, () =>
    ports.caseInfo(caseId)
  );
  if (!info.ok) return 'error';
  if (!info.value) {
    log('NO_CASE', ids);
    return 'no_case';
  }
  const accountId = info.value.accountId;
  if (info.value.managedExternally) return 'off';

  const on = await attempt(log, 'intakeEnabled', ids, () =>
    ports.intakeEnabled(accountId)
  );
  if (!on.ok) return 'error';
  if (!on.value) return 'off';

  const body = await attempt(log, 'approvedTemplate', ids, () =>
    ports.approvedTemplate(accountId, 'classify')
  );
  if (!body.ok) return 'error';
  if (!body.value) {
    log('TEMPLATE_NOT_APPROVED', { ...ids, kind: 'classify' });
    return 'not_approved';
  }

  const sender = senderOf(info.value);
  if (!sender.ok) {
    log(sender.outcome.toUpperCase(), ids);
    return sender.outcome;
  }
  if (sender.groupId !== groupId) {
    log('NO_GROUP', ids);
    return 'no_group';
  }
  const mode = await attempt(log, 'groupMode', ids, () =>
    ports.groupMode(groupId)
  );
  if (!mode.ok) return 'error';
  if (mode.value !== 'group') {
    log('NO_GROUP', { ...ids, mode: mode.value });
    return 'no_group';
  }

  // First write.
  const fileId = await attempt(log, 'register', ids, () =>
    ports.register(caseId, customerDocumentId)
  );
  if (!fileId.ok) return 'error';

  const lists = await attempt(log, 'checklist', ids, () =>
    Promise.all([ports.checklist(caseId), ports.passedDocKeys(caseId)])
  );
  if (!lists.ok) return 'error';
  const options = buildIntakeOptions(lists.value[0], lists.value[1]);
  if (options.length === 0) return 'no_options';

  const text = renderIntakeTemplate(body.value, {
    file: input.fileName?.trim() || DEFAULT_FILE,
    list: renderIntakeList(options),
  });
  const sent = await sendAs(ports, log, caseId, sender, text);
  if (!sent.sent) return 'not_sent';
  if (!sent.recorded)
    log('SENT_NOT_RECORDED', { ...ids, fileId: fileId.value });

  const recorded = await attempt(
    log,
    'recordPrompt',
    { ...ids, fileId: fileId.value },
    () =>
      ports.recordPrompt({
        caseId,
        fileId: fileId.value,
        options,
        now: input.now,
      })
  );
  return recorded.ok ? 'prompted' : 'error';
}

/**
 * A customer's text in the case's group: a bare number answers the open
 * prompt, classifies the file and reports the checks' result.
 */
export async function onCustomerGroupText(
  ports: IntakePorts,
  input: { caseId: string; body: string; now: Date }
): Promise<IntakeOutcome> {
  const log = logger(ports);
  const { caseId } = input;
  const ids = { caseId };

  // Pure, before any read: most customer texts are not answers.
  const choice = parseIntakeChoice(input.body);
  if (choice === null) return 'not_an_answer';

  const info = await attempt(log, 'caseInfo', ids, () =>
    ports.caseInfo(caseId)
  );
  if (!info.ok) return 'error';
  if (!info.value) return 'no_case';
  const accountId = info.value.accountId;
  if (info.value.managedExternally) return 'off';

  const on = await attempt(log, 'intakeEnabled', ids, () =>
    ports.intakeEnabled(accountId)
  );
  if (!on.ok) return 'error';
  if (!on.value) return 'off';

  const prompt = await attempt(log, 'openPrompt', ids, () =>
    ports.openPrompt(caseId)
  );
  if (!prompt.ok) return 'error';
  if (!prompt.value) return 'no_prompt';
  const promptId = prompt.value.id;

  const answer = await attempt(log, 'answerPrompt', { caseId, promptId }, () =>
    ports.answerPrompt({ promptId, choice, now: input.now })
  );
  if (!answer.ok) return 'answer_refused';
  const { fileId, docKey } = answer.value;
  const option = prompt.value.options.find((o) => o.docKey === docKey);
  const doc = intakeLabel(docKey, option?.label ?? null);

  const result = await attempt(
    log,
    'classifyAndCheck',
    { caseId, fileId },
    () =>
      ports.classifyAndCheck({
        fileId,
        docKey,
        today: input.now.toISOString().slice(0, 10),
      })
  );
  if (!result.ok) return 'error';

  const sender = senderOf(info.value);

  if (result.value.status === 'failed') {
    const tpl = await attempt(log, 'approvedTemplate', ids, () =>
      ports.approvedTemplate(accountId, 'document_rejected')
    );
    if (!tpl.ok) return 'error';
    if (!tpl.value || !sender.ok) return 'rejected';
    const checks = result.value.checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join(', ');
    await sendAs(
      ports,
      log,
      caseId,
      sender,
      renderIntakeTemplate(tpl.value, { doc, checks })
    );
    return 'rejected';
  }

  const ready = await attempt(log, 'fileReady', ids, () =>
    ports.fileReady(caseId)
  );
  if (!ready.ok) return 'error';
  if (ready.value) return 'ready';

  const tpl = await attempt(log, 'approvedTemplate', ids, () =>
    ports.approvedTemplate(accountId, 'document_received_next')
  );
  if (!tpl.ok) return 'error';
  if (!tpl.value || !sender.ok) return 'received';
  const lists = await attempt(log, 'checklist', ids, () =>
    Promise.all([ports.checklist(caseId), ports.passedDocKeys(caseId)])
  );
  if (!lists.ok) return 'error';
  const remaining = buildIntakeOptions(lists.value[0], lists.value[1]);
  if (remaining.length === 0) return 'received';
  await sendAs(
    ports,
    log,
    caseId,
    sender,
    renderIntakeTemplate(tpl.value, { doc, list: renderIntakeList(remaining) })
  );
  return 'received';
}
