/**
 * Pure helpers behind Settings → Journey bot (module 016): the templates
 * checklist, the copy editor (its starting state, the overrides it
 * saves, WhatsApp's title limits) and the Call-button number. No I/O,
 * so the panel stays a thin client and these are unit-tested.
 */
import type { WorkflowDef } from './schema';
import {
  LIST_BUTTON_LABEL_MAX,
  LIST_ROW_TITLE_MAX,
  REPLY_BUTTON_TITLE_MAX,
  type JourneyCopy,
  type SessionCopy,
} from './host/copy';

// ------------------------------------------------------------
// Templates checklist
// ------------------------------------------------------------

/**
 * A MARKETING / UTILITY template on a Meta number: `approved` sends;
 * `pending` is waiting on Meta's review (PENDING, IN_APPEAL);
 * `notApproved` is any other status (a DRAFT not yet submitted,
 * REJECTED, PAUSED, …) and is skipped like a missing one.
 */
export type MetaTemplateState =
  'approved' | 'pending' | 'notApproved' | 'missing';
/** On a Whapi number any row is rendered locally, whatever its status. */
export type WhapiTemplateState = 'present' | 'missing';

export interface TemplateRowLite {
  name: string;
  language?: string | null;
  status?: string | null;
}

export interface ChecklistItem {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  /** Quick-reply payload ids, in button order. */
  buttons: string[];
  /** Carries the Call Taamul phone button, so it needs the account's number. */
  phoneButton: boolean;
  /** Only when the account has a Meta number. */
  meta?: MetaTemplateState;
  /** The status of the row a send would use (upper case), when there is one. */
  metaStatus?: string;
  /** Only when the account has a Whapi number. */
  whapi?: WhapiTemplateState;
}

const AWAITING_REVIEW = new Set(['PENDING', 'IN_APPEAL']);

/**
 * The row a journey send uses when a template exists in several
 * languages — `resolveTemplateRow` with no language asked for: en_US,
 * then en, then the first by language.
 */
export function rowForSend<T extends TemplateRowLite>(rows: T[]): T | null {
  const sorted = rows
    .slice()
    .sort((a, b) => (a.language ?? '').localeCompare(b.language ?? ''));
  return (
    sorted.find((r) => r.language === 'en_US') ??
    sorted.find((r) => r.language === 'en') ??
    sorted[0] ??
    null
  );
}

/**
 * Every MARKETING and UTILITY template of the workflow, in workflow
 * order, with its state on each kind of number the account has
 * (`kinds` = the providers of its `whatsapp_config` rows). SESSION
 * messages are left out: they need no template.
 */
export function templateChecklist(
  def: Pick<WorkflowDef, 'templates'>,
  rows: readonly TemplateRowLite[],
  kinds: readonly string[]
): ChecklistItem[] {
  const byName = new Map<string, TemplateRowLite[]>();
  for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const hasMeta = kinds.includes('meta');
  const hasWhapi = kinds.includes('whapi');

  const items: ChecklistItem[] = [];
  for (const [name, t] of Object.entries(def.templates)) {
    if (t.category === 'SESSION') continue;
    const mine = byName.get(name) ?? [];
    const item: ChecklistItem = {
      name,
      category: t.category,
      buttons: [...t.buttons],
      phoneButton: !!t.phoneButton,
    };
    if (hasMeta) {
      const row = rowForSend(mine);
      const status = String(row?.status ?? '').toUpperCase();
      item.meta = !row
        ? 'missing'
        : status === 'APPROVED'
          ? 'approved'
          : AWAITING_REVIEW.has(status)
            ? 'pending'
            : 'notApproved';
      if (row) item.metaStatus = status;
    }
    if (hasWhapi) item.whapi = mine.length ? 'present' : 'missing';
    items.push(item);
  }
  return items;
}

// ------------------------------------------------------------
// Copy editor
// ------------------------------------------------------------

/** One SESSION message as the editor holds it; '' means "the default". */
export interface MessageForm {
  body: string;
  buttonLabel: string;
  variants: Record<string, string>;
}

export interface CopyForm {
  messages: Record<string, MessageForm>;
  /** Every payload title the defaults know, '' for the default. */
  titles: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A message's editor state with nothing overridden. */
export function blankMessageForm(d: SessionCopy): MessageForm {
  return {
    body: '',
    buttonLabel: '',
    variants: Object.fromEntries(
      Object.keys(d.variants ?? {}).map((k) => [k, ''])
    ),
  };
}

/**
 * The editor's starting state from the saved `journey_settings.copy`:
 * each saved override where there is one, else '' (the default shows as
 * the placeholder). Only keys the defaults know are editable.
 */
export function copyFormFrom(saved: unknown, defaults: JourneyCopy): CopyForm {
  const s = isRecord(saved) ? saved : {};
  const sm = isRecord(s.messages) ? s.messages : {};
  const st = isRecord(s.titles) ? s.titles : {};
  const messages: Record<string, MessageForm> = {};
  for (const [name, d] of Object.entries(defaults.messages)) {
    const o = isRecord(sm[name]) ? sm[name] : {};
    const ov = isRecord(o.variants) ? o.variants : {};
    messages[name] = {
      body: str(o.body),
      buttonLabel: str(o.buttonLabel),
      variants: Object.fromEntries(
        Object.keys(d.variants ?? {}).map((k) => [k, str(ov[k])])
      ),
    };
  }
  const titles = Object.fromEntries(
    Object.keys(defaults.titles).map((id) => [id, str(st[id])])
  );
  return { messages, titles };
}

export interface CopyOverrides {
  messages?: Record<
    string,
    { body?: string; buttonLabel?: string; variants?: Record<string, string> }
  >;
  titles?: Record<string, string>;
}

/**
 * The `copy` to PUT (it replaces the whole override object): only the
 * values that differ from the default, trimmed as `mergeCopy` reads
 * them. A blank value, or one equal to the default, is left out, so the
 * default applies — and keeps applying if the default changes.
 */
export function copyOverrides(
  form: CopyForm,
  defaults: JourneyCopy
): CopyOverrides {
  const changed = (value: string | undefined, def: string | undefined) => {
    const v = (value ?? '').trim();
    return v && v !== (def ?? '').trim() ? v : undefined;
  };
  const messages: NonNullable<CopyOverrides['messages']> = {};
  for (const [name, d] of Object.entries(defaults.messages)) {
    const f = form.messages[name];
    if (!f) continue;
    const m: NonNullable<CopyOverrides['messages']>[string] = {};
    const body = changed(f.body, d.body);
    if (body) m.body = body;
    const label = changed(f.buttonLabel, d.buttonLabel);
    if (label) m.buttonLabel = label;
    const variants: Record<string, string> = {};
    for (const k of Object.keys(d.variants ?? {})) {
      const v = changed(f.variants[k], d.variants?.[k]);
      if (v) variants[k] = v;
    }
    if (Object.keys(variants).length) m.variants = variants;
    if (Object.keys(m).length) messages[name] = m;
  }
  const titles: Record<string, string> = {};
  for (const [id, d] of Object.entries(defaults.titles)) {
    const v = changed(form.titles[id], d);
    if (v) titles[id] = v;
  }
  return {
    ...(Object.keys(messages).length ? { messages } : {}),
    ...(Object.keys(titles).length ? { titles } : {}),
  };
}

/** Same overrides? (The editor's dirty check.) */
export function sameOverrides(a: CopyOverrides, b: CopyOverrides): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The SESSION messages the editor shows, in workflow order, each with its payloads. */
export function sessionMessages(
  def: Pick<WorkflowDef, 'templates'>,
  defaults: JourneyCopy
): { name: string; list: boolean; buttons: string[] }[] {
  return Object.entries(def.templates)
    .filter(([name, t]) => t.category === 'SESSION' && defaults.messages[name])
    .map(([name, t]) => ({
      name,
      list: t.interactive === 'list',
      buttons: [...t.buttons],
    }));
}

/**
 * WhatsApp's limit on each payload title a SESSION message shows: 20 for
 * a reply button, 24 for a list row, the tighter one when a payload is
 * both (titles are shared by every message that uses the payload).
 */
export function sessionTitleLimits(
  def: Pick<WorkflowDef, 'templates'>
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const t of Object.values(def.templates)) {
    if (t.category !== 'SESSION') continue;
    const max =
      t.interactive === 'list' ? LIST_ROW_TITLE_MAX : REPLY_BUTTON_TITLE_MAX;
    for (const id of t.buttons) limits[id] = Math.min(limits[id] ?? max, max);
  }
  return limits;
}

/** Characters as WhatsApp counts them (code points, as `clip` does), trimmed. */
export const textLength = (s: string) => [...s.trim()].length;

export interface CopyProblem {
  kind: 'title' | 'buttonLabel';
  /** The payload id (title) or the message name (button label). */
  key: string;
  length: number;
  max: number;
}

/** Overrides too long for WhatsApp; Save stays off while there are any. */
export function copyProblems(
  form: CopyForm,
  def: Pick<WorkflowDef, 'templates'>
): CopyProblem[] {
  const problems: CopyProblem[] = [];
  for (const [id, max] of Object.entries(sessionTitleLimits(def))) {
    const length = textLength(form.titles[id] ?? '');
    if (length > max) problems.push({ kind: 'title', key: id, length, max });
  }
  for (const [name, m] of Object.entries(form.messages)) {
    const length = textLength(m.buttonLabel);
    if (length > LIST_BUTTON_LABEL_MAX)
      problems.push({
        kind: 'buttonLabel',
        key: name,
        length,
        max: LIST_BUTTON_LABEL_MAX,
      });
  }
  return problems;
}

// ------------------------------------------------------------
// Call Taamul number
// ------------------------------------------------------------

/** The CHECK on journey_settings.taamul_did (migration 086), as the route applies it. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * The Call-button number as the PUT stores it: spaces and dashes
 * dropped, `null` to clear (blank input). `ok: false` when it is not an
 * international number such as +97141234567.
 */
export function parseTaamulDid(
  raw: string
): { ok: true; value: string | null } | { ok: false } {
  const did = raw.replace(/[\s-]/g, '');
  if (!did) return { ok: true, value: null };
  return E164.test(did) ? { ok: true, value: did } : { ok: false };
}
