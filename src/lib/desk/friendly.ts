/**
 * Plain words for the case desk, for office staff who never see a code.
 * Every function answers with an i18n key under the `DeskFriendly`
 * namespace plus its values (never English), so Arabic and Korean read
 * the same sentence. Pure: the screen decides nothing here that the
 * server does not decide again (filing, queues, refusals are the
 * server's); these only say what happened, or what the button will do.
 */
import type { DocType } from './doc-types';
import type { ItemKind, ItemResult } from './store';

export type TextValues = Record<string, string | number>;

export interface FriendlyText {
  key: string;
  values?: TextValues;
}

// ---------- Why an upload waits ----------

/**
 * Queue reasons (`intake_route`, migrations 220 and 289) and the refusal
 * hints `intake_route` can store as a reason (`desk_case_open` /
 * `intake_apply` failures), each with a sentence of its own.
 */
export const REASON_SENTENCE_CODES = [
  'NO_KIND',
  'NO_CASE',
  'NO_CONTACT',
  'NO_FILE',
  'CASE_NOT_FOUND',
  'BANK_MISMATCH',
  'CASE_EXISTS_NAME_MISMATCH',
  'COMPANY_RESTRICTED',
  'CASE_OPEN_FAILED',
  'FILE_FAILED',
  'CASE_CONFLICT',
  'CASE_CLOSED',
  'BANK_UNKNOWN',
  'BANK_CODE_MISSING',
  'FILE_INVALID',
  'CROSS_CUSTOMER',
  'NOT_ALLOWED',
] as const;
const KNOWN_REASONS: ReadonlySet<string> = new Set(REASON_SENTENCE_CODES);

/** Reasons that are about what the uploader left out: they name the person. */
const BY_UPLOADER: ReadonlySet<string> = new Set([
  'NO_KIND',
  'NO_CASE',
  'NO_CONTACT',
  'NO_FILE',
]);

/**
 * Why an upload waits, as one sentence ("Omar did not say which case").
 * An unknown code reads as a general sentence, never as the code itself.
 */
export function reasonSentence(
  code: string | null | undefined,
  uploaderName?: string | null
): FriendlyText | null {
  if (code === null || code === undefined || code === '') return null;
  if (!KNOWN_REASONS.has(code)) return { key: 'reason.OTHER' };
  const name = uploaderName?.trim();
  if (name && BY_UPLOADER.has(code))
    return { key: `reasonBy.${code}`, values: { name } };
  return { key: `reason.${code}` };
}

// ---------- The upload button ----------

export interface UploadFormState {
  kind: ItemKind | '';
  /** Files chosen (the desk sends one file per upload today). */
  fileCount: number;
  /** The case number the lookup found, when it found one. */
  foundCaseNumber: string | null;
  busy: boolean;
  /** Typed into the form, so the "it will wait" note can stay quiet. */
  caseRef: string;
  caption: string;
  /** New-case fields still empty (`newCaseMissing`), in form order. */
  newCaseMissing: readonly string[];
}

export interface UploadButtonState {
  labelKey: string;
  values: TextValues;
  disabled: boolean;
  /** The one thing still missing, when the button cannot be pressed. */
  missingKey: string | null;
  /**
   * Not a block: the upload is accepted but will wait in a sorting queue
   * (the server decides; this only warns). Silent when a caption is typed,
   * since a caption may fill what the form left empty.
   */
  waitKey: 'wait.noKind' | 'wait.noCase' | 'wait.newCaseIncomplete' | null;
}

/**
 * What the upload button says and whether it may be pressed. The only
 * block is the form's own (and the server's NO_FILE): a pending document
 * needs its file. Everything else is accepted and, if incomplete, waits
 * to be sorted; that is a note, not a requirement.
 */
export function uploadButtonState(f: UploadFormState): UploadButtonState {
  const count = Math.max(0, Math.floor(f.fileCount));
  const caption = f.caption.trim() !== '';
  let waitKey: UploadButtonState['waitKey'] = null;
  if (!caption) {
    if (f.kind === '') waitKey = 'wait.noKind';
    else if (f.kind === 'new_case')
      waitKey = f.newCaseMissing.length > 0 ? 'wait.newCaseIncomplete' : null;
    else if (f.caseRef.trim() === '') waitKey = 'wait.noCase';
  }
  const base = { waitKey };

  if (f.kind === 'pending_doc' && count === 0)
    return {
      ...base,
      labelKey: 'button.upload',
      values: { count },
      disabled: true,
      missingKey: 'missing.file',
    };
  if (f.busy)
    return {
      ...base,
      labelKey: 'button.uploading',
      values: {},
      disabled: true,
      missingKey: null,
    };

  const ok = { ...base, disabled: false, missingKey: null };
  if (f.kind === 'new_case')
    return { ...ok, labelKey: 'button.newCase', values: { count } };
  if (f.kind === 'info')
    return f.foundCaseNumber
      ? {
          ...ok,
          labelKey: 'button.infoTo',
          values: { count, caseNumber: f.foundCaseNumber },
        }
      : { ...ok, labelKey: 'button.info', values: { count } };
  if (f.kind === 'pending_doc' && f.foundCaseNumber)
    return {
      ...ok,
      labelKey: 'button.uploadTo',
      values: { count, caseNumber: f.foundCaseNumber },
    };
  return { ...ok, labelKey: 'button.upload', values: { count } };
}

// ---------- Upload steps ----------

/**
 * How many of the three upload steps show: 1 (what is it), 2 (which case
 * or company), 3 (file, type, note). A step that already holds a value
 * always shows, and "show everything" opens all three (a caption-only or
 * untyped upload stays possible, as before).
 */
export function visibleUploadSteps(i: {
  kind: string;
  step2HasValue: boolean;
  step3HasValue: boolean;
  showAll: boolean;
}): 1 | 2 | 3 {
  if (i.showAll || i.step3HasValue || i.step2HasValue) return 3;
  return i.kind === '' ? 1 : 2;
}

/**
 * The bank field beside a found case: read-only text when nothing was
 * chosen (the case already names its bank; nothing is set for the
 * person), the pick list otherwise, flagged when it disagrees with the
 * case (the server would send it to the queue as BANK_MISMATCH).
 */
export function caseBankView(i: {
  foundBankCode: string | null | undefined;
  chosenBankCode: string;
}): 'select' | 'readonly' | 'mismatch' {
  if (i.foundBankCode === undefined) return 'select';
  if (i.chosenBankCode === '') return 'readonly';
  return i.foundBankCode !== null && i.chosenBankCode !== i.foundBankCode
    ? 'mismatch'
    : 'select';
}

/** The keys put first among the quick picks, when the workspace has them. */
export const COMMON_DOC_KEYS = [
  'trade_licence',
  'emirates_id',
  'passport',
  'visa',
  'moa',
  'ejari',
  'bank_statement',
  'vat_certificate',
] as const;

/**
 * Document types for quick-pick chips: the common ones the workspace has,
 * then the rest in list order, at most `max`. A type already chosen is
 * always among them (it replaces the last) so the chosen chip shows.
 */
export function quickDocTypes(
  types: readonly DocType[],
  current: string,
  max = 8
): DocType[] {
  const byKey = new Map(types.map((t) => [t.key, t]));
  const out: DocType[] = [];
  for (const k of COMMON_DOC_KEYS) {
    const t = byKey.get(k);
    if (t) out.push(t);
  }
  for (const t of types) if (!out.includes(t)) out.push(t);
  const picks = out.slice(0, Math.max(0, max));
  const chosen = byKey.get(current);
  if (chosen && !picks.includes(chosen) && picks.length > 0)
    picks[picks.length - 1] = chosen;
  return picks;
}

// ---------- Sizes ----------

/** A file size such as "240 KB" or "3.4 MB", in the reader's language. */
export function fileSizeText(bytes: number, locale = 'en'): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const fmt = (v: number, unit: 'byte' | 'kilobyte' | 'megabyte') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: unit === 'megabyte' ? 1 : 0,
    }).format(v);
  if (n < 1024) return fmt(n, 'byte');
  if (n < 1024 * 1024) return fmt(Math.round(n / 1024), 'kilobyte');
  return fmt(n / (1024 * 1024), 'megabyte');
}

// ---------- One upload's result ----------

export type ResultAction = 'copyCode' | 'openCase' | 'fixInMine';

export interface ResultLineText extends FriendlyText {
  /** Why it waits, as its own sentence, for a queued upload. */
  reason: FriendlyText | null;
  tone: 'success' | 'warning' | 'info' | 'destructive';
  actions: ResultAction[];
}

/**
 * One upload's result in plain words. `kind` is what the person sent
 * (the result does not carry it); a filed new case reads as opened.
 */
export function resultLine(
  item: ItemResult,
  ctx: {
    kind?: ItemKind | '' | null;
    docTypeLabel?: string | null;
    bankName?: string | null;
  } = {}
): ResultLineText {
  const caseNo = item.caseNumber ?? '';
  const open: ResultAction[] = item.caseId ? ['openCase'] : [];
  if (item.state === 'filed') {
    const copy: ResultAction[] = item.captionCode ? ['copyCode'] : [];
    if (ctx.kind === 'new_case' && item.captionCode)
      return {
        key: 'result.newCase',
        values: { caseNumber: caseNo, code: item.captionCode },
        reason: null,
        tone: 'success',
        actions: [...copy, ...open],
      };
    return {
      ...(ctx.docTypeLabel
        ? {
            key: 'result.filedAs',
            values: { caseNumber: caseNo, docType: ctx.docTypeLabel },
          }
        : { key: 'result.filed', values: { caseNumber: caseNo } }),
      reason: null,
      tone: 'success',
      actions: [...copy, ...open],
    };
  }
  if (item.state === 'duplicate')
    return {
      key: 'result.duplicate',
      values: {},
      reason: null,
      tone: 'info',
      actions: open,
    };
  if (item.state === 'rejected')
    return {
      key: 'result.rejected',
      values: {},
      reason: null,
      tone: 'destructive',
      actions: [],
    };
  return {
    ...(ctx.bankName
      ? { key: 'result.queued', values: { bank: ctx.bankName } }
      : { key: 'result.queuedNoBank', values: {} }),
    reason: reasonSentence(item.queueReason),
    tone: 'warning',
    actions: ['fixInMine'],
  };
}

// ---------- Grouping by day (My uploads, sorting queue) ----------

export interface DayGroup<T> {
  /** YYYY-MM-DD in the given time zone. */
  day: string;
  when: 'today' | 'yesterday' | 'earlier';
  items: T[];
}

function dayIn(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Items grouped by calendar day in `timeZone`, newest day first, each
 * group keeping the items' own order. Unreadable dates go last.
 */
export function groupByDay<T extends { receivedAt: string }>(
  items: readonly T[],
  now: Date,
  timeZone: string
): DayGroup<T>[] {
  const today = dayIn(now, timeZone);
  const yesterday = dayIn(new Date(now.getTime() - 86_400_000), timeZone);
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const d = new Date(it.receivedAt);
    const key = Number.isNaN(d.getTime()) ? '' : dayIn(d, timeZone);
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a)))
    .map(([day, list]) => ({
      day,
      when:
        day === today ? 'today' : day === yesterday ? 'yesterday' : 'earlier',
      items: list,
    }));
}
