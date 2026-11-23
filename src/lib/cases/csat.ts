/**
 * Customer satisfaction (CSAT) for cases (migration 246,
 * docs/case-csat.md): a 1-5 rating request when a case is submitted and
 * when it is approved, and the customer's reply.
 *
 * The SQL queues (a trigger on stage history), guards (switch, opt-out,
 * do-not-contact, send hours, one request per person per day) and
 * claims; this module holds the pure decisions (reply parser, trigger
 * mirror, message text, send decision, averages), drains what SQL claims
 * and records a reply. Client-safe except for the `SupabaseClient` type:
 * no server import.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type CsatTrigger = 'submitted' | 'approved';
export const CSAT_TRIGGERS: readonly CsatTrigger[] = ['submitted', 'approved'];

/** 246's case_csat_requests status CHECK, in lifecycle order. */
export const CSAT_REQUEST_STATUSES = [
  'queued',
  'held',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'unconfirmed',
  'skipped',
] as const;
export type CsatRequestStatus = (typeof CSAT_REQUEST_STATUSES)[number];

/** 246's column defaults (csat.test.ts reads the migration). */
export const CSAT_DEFAULTS = {
  enabled: false,
  askOnSubmitted: true,
  askOnApproved: true,
  templateSubmitted: 'case_csat_submitted',
  templateApproved: 'case_csat_approved',
  language: 'en',
  replyWindowDays: 7,
  sendStartHour: 9,
  sendEndHour: 20,
} as const;

export interface CsatSettings {
  enabled: boolean;
  askOnSubmitted: boolean;
  askOnApproved: boolean;
  templateSubmitted: string;
  templateApproved: string;
  language: string;
  replyWindowDays: number;
  sendStartHour: number;
  sendEndHour: number;
  /** The version the editor read; null for a workspace that never saved. */
  updatedAt: string | null;
}

// ---------- When to ask (mirror of case_csat_trigger_for) ----------

/** 130's case_presub_stages(). */
const PRESUB = new Set(['Interested', 'Data collection', 'Review']);
const FINAL = new Set(['Approved', 'Declined', 'Withdrawn', 'Closed']);

/**
 * Which rating request a stage write asks for: 'approved' on Approved
 * (stage or outcome); 'submitted' when the case leaves the pre-submission
 * stages for a stage that is not final; else null.
 */
export function csatTriggerFor(
  from: string | null,
  to: string | null,
  outcome: string | null = null
): CsatTrigger | null {
  if (to === 'Approved' || outcome === 'Approved') return 'approved';
  if (
    to !== null &&
    !PRESUB.has(to) &&
    !FINAL.has(to) &&
    (from === null || PRESUB.has(from))
  )
    return 'submitted';
  return null;
}

// ---------- The reply ----------

/** Arabic-Indic (U+0660..) and extended Arabic-Indic (U+06F0..) digits as ASCII. */
export function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

const MAX_REPLY = 1000;
const STAR = /⭐|★|🌟/g;

export interface CsatReply {
  score: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
}

// Star emoji once the variation selector is gone.
const STAR_CLASS = '[⭐★🌟]';
// What may trail a rating that is the whole message: punctuation, emoji
// (a keycap's U+20E3 included) and space. Never % + / # or a letter.
const TRAIL =
  '[\\s.,،!؟?;؛:…*~)\'"’”»–—\\-\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u200D\\u20E3]*';
const END_WORD = '(?![\\p{L}\\p{M}\\p{N}])';
// Unmistakably a rating, so a bare space may lead into the comment.
const EXPLICIT = `(?:\\/ ?5|out of 5|stars?|نجوم|نجمة|نجمات)${END_WORD}|${STAR_CLASS}+`;
// "4 of 5 documents sent" is not a rating: these need a separator.
const OUT_OF = `(?:of 5|من ?5)${END_WORD}`;

const RE_WHOLE = new RegExp(
  `^([1-5])(?: ?(?:${EXPLICIT}|${OUT_OF})){0,2}${TRAIL}$`,
  'iu'
);
const RE_SEPARATED = new RegExp(
  `^([1-5])(?: ?(?:${EXPLICIT}|${OUT_OF})){0,2} ?[,،\\-–—:;؛!\\n][,،\\-–—:;؛!\\s]*((?![\\p{N}\\s,،\\-–—:;؛!])[\\s\\S]+)$`,
  'iu'
);
const RE_EXPLICIT = new RegExp(
  `^([1-5]) ?(?:${EXPLICIT})(?: ?${STAR_CLASS}+)? ((?!\\p{N})[\\s\\S]+)$`,
  'iu'
);
const RE_STARS = new RegExp(
  `^(${STAR_CLASS}(?: ?${STAR_CLASS})*)(?:${TRAIL}|\\s+((?!\\p{N})[\\s\\S]+))$`,
  'u'
);

/**
 * A rating reply, read strictly: while a request is open the message is
 * consumed and stored against an agent, so "2 years in business" or "1.
 * Passport" must stay an ordinary message. A rating is
 *  (a) the whole message: one digit 1-5 (ASCII or Arabic-Indic) with an
 *      optional "/5", "out of 5", "of 5", "من 5", "stars" / نجوم or star
 *      emoji, then only punctuation, emoji and space;
 *  (b) that, then a separator (comma, dash, colon, semicolon,
 *      exclamation, new line) and a comment not starting with a digit;
 *  (c) an explicit form ("5/5", "5 out of 5", "5 stars"), a space and a
 *      comment;
 *  (d) 1-5 star emoji alone, or with a comment after a space.
 * A lone digit followed by a space, a full stop or a closing bracket and
 * words is not a rating. Anything else is null: never a guess.
 */
export function parseCsatReply(
  text: string | null | undefined
): CsatReply | null {
  if (!text) return null;
  const t = asciiDigits(text)
    .replace(/️/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
  if (t.length === 0 || t.length > MAX_REPLY + 20) return null;

  let score: number;
  let rest: string | undefined;
  const stars = RE_STARS.exec(t);
  if (stars) {
    score = (stars[1]!.match(STAR) ?? []).length;
    rest = stars[2];
    if (score > 5) return null;
  } else {
    const m = RE_WHOLE.exec(t) ?? RE_SEPARATED.exec(t) ?? RE_EXPLICIT.exec(t);
    if (!m) return null;
    score = Number(m[1]);
    rest = m[2];
  }
  const comment = (rest ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY);
  return {
    score: score as CsatReply['score'],
    comment: comment.length > 0 ? comment : null,
  };
}

// ---------- The request ----------

/**
 * The coordinator-approved wording (docs/plans/track-c-csat-template.md),
 * the body of the Meta template per trigger and the text sent on Whapi
 * and OpenWA: {{1}} = the customer's first name, {{2}} = bank and
 * product. Pinned by csat.test.ts.
 */
export const CSAT_TEMPLATE_BODIES: Readonly<
  Record<'en' | 'ar', Record<CsatTrigger, string>>
> = {
  en: {
    submitted:
      'Hi {{1}}, your {{2}} application has been submitted to the bank. How happy are you with our service so far? Reply with a number from 1 (not happy) to 5 (very happy).',
    approved:
      'Hi {{1}}, good news: your {{2}} account has been approved! How would you rate our service? Reply with a number from 1 (not happy) to 5 (very happy).',
  },
  ar: {
    submitted:
      'مرحبًا {{1}}، تم تقديم طلب {{2}} الخاص بك إلى البنك. ما مدى رضاك عن خدمتنا حتى الآن؟ أرسل رقمًا من 1 (غير راضٍ) إلى 5 (راضٍ جدًا).',
    approved:
      'مرحبًا {{1}}، خبر سار: تمت الموافقة على حساب {{2}} الخاص بك! كيف تقيّم خدمتنا؟ أرسل رقمًا من 1 (غير راضٍ) إلى 5 (راضٍ جدًا).',
  },
};

/** Arabic for a language code starting "ar", else English. */
export function csatLanguage(language: string | null | undefined): 'en' | 'ar' {
  return (language ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/**
 * {{1}}: the first word of the contact's name when it reads as a name
 * (letters only, as many contacts are saved under their number), else a
 * neutral word.
 */
export function csatFirstName(
  name: string | null | undefined,
  language: string | null | undefined
): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  if (/^[\p{L}][\p{L}\p{M}'’-]{0,39}$/u.test(first)) return first;
  return csatLanguage(language) === 'ar' ? 'عميلنا العزيز' : 'there';
}

/**
 * {{2}}: "Emirates NBD business account" (bank, then the product in
 * lower case). The approved wording already says "your {{2}} account", so
 * a product ending in "account" drops that word there ("your Emirates
 * NBD business account has been approved").
 */
export function csatBankProduct(
  trigger: CsatTrigger,
  bankName: string | null | undefined,
  product: string | null | undefined
): string {
  const bank = bankName?.trim() || '';
  let prod = (product ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (trigger === 'approved') prod = prod.replace(/\s*\baccount$/, '');
  const out = [bank, prod].filter(Boolean).join(' ');
  return out || 'bank';
}

/** The template's two parameters for a claimed request. */
export function csatParams(input: {
  trigger: CsatTrigger;
  contactName: string | null;
  bankName: string | null;
  product: string | null;
  language: string | null | undefined;
}): [string, string] {
  return [
    csatFirstName(input.contactName, input.language),
    csatBankProduct(input.trigger, input.bankName, input.product),
  ];
}

/**
 * The plain-text request (Whapi, OpenWA, and Meta inside the customer's
 * 24-hour window): the approved wording with its parameters filled in.
 */
export function buildCsatText(input: {
  trigger: CsatTrigger;
  contactName: string | null;
  bankName: string | null;
  product: string | null;
  language: string | null | undefined;
}): string {
  const [name, bank] = csatParams(input);
  return CSAT_TEMPLATE_BODIES[csatLanguage(input.language)][input.trigger]
    .replace('{{1}}', () => name)
    .replace('{{2}}', () => bank);
}

/**
 * How a claimed request goes out: text on a linked-device number
 * (Whapi, OpenWA) and on Meta inside the customer's 24-hour window; the
 * approved template on Meta outside it; else held until a template is
 * approved (nothing sent, not a failure).
 */
export function decideCsatSend(input: {
  provider: 'meta' | 'whapi' | 'openwa';
  windowOpen: boolean;
  templateApproved: boolean;
}): 'text' | 'template' | 'hold' {
  if (input.provider !== 'meta') return 'text';
  if (input.windowOpen) return 'text';
  return input.templateApproved ? 'template' : 'hold';
}

// ---------- Averages ----------

export interface CsatScoreRow {
  caseId: string;
  trigger: CsatTrigger;
  agentId: string | null;
  bankCode: string | null;
  bankName: string | null;
  score: number;
}

export interface CsatAverage {
  key: string | null;
  label: string | null;
  average: number;
  count: number;
}

export interface CsatAverages {
  overall: { average: number; count: number } | null;
  byAgent: CsatAverage[];
  byBank: CsatAverage[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function groupAverage(
  rows: CsatScoreRow[],
  keyOf: (r: CsatScoreRow) => string | null,
  labelOf: (r: CsatScoreRow) => string | null
): CsatAverage[] {
  const acc = new Map<
    string,
    { key: string | null; label: string | null; sum: number; count: number }
  >();
  for (const r of rows) {
    const key = keyOf(r);
    const id = key ?? '\u0000none';
    const cur = acc.get(id) ?? { key, label: labelOf(r), sum: 0, count: 0 };
    cur.sum += r.score;
    cur.count += 1;
    acc.set(id, cur);
  }
  return [...acc.values()]
    .map((g) => ({
      key: g.key,
      label: g.label,
      average: round1(g.sum / g.count),
      count: g.count,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.average - a.average ||
        String(a.label ?? a.key ?? '').localeCompare(
          String(b.label ?? b.key ?? '')
        )
    );
}

/**
 * Average score overall, per agent and per bank (one decimal), most
 * rated first. Scores outside 1-5 are ignored.
 */
export function aggregateCsat(rows: readonly CsatScoreRow[]): CsatAverages {
  const valid = rows.filter(
    (r) => Number.isInteger(r.score) && r.score >= 1 && r.score <= 5
  );
  if (valid.length === 0) return { overall: null, byAgent: [], byBank: [] };
  const sum = valid.reduce((s, r) => s + r.score, 0);
  return {
    overall: { average: round1(sum / valid.length), count: valid.length },
    byAgent: groupAverage(
      valid,
      (r) => r.agentId,
      () => null
    ),
    byBank: groupAverage(
      valid,
      (r) => r.bankCode,
      (r) => r.bankName ?? r.bankCode
    ),
  };
}

/** Rows from case_csat_scores, read defensively. */
export function parseScoreRows(data: unknown): CsatScoreRow[] {
  if (!Array.isArray(data)) return [];
  const out: CsatScoreRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const trigger = r.trigger === 'approved' ? 'approved' : 'submitted';
    const score = Number(r.score);
    if (typeof r.case_id !== 'string' || !Number.isInteger(score)) continue;
    out.push({
      caseId: r.case_id,
      trigger,
      agentId: typeof r.agent_id === 'string' ? r.agent_id : null,
      bankCode: typeof r.bank_code === 'string' ? r.bank_code : null,
      bankName: typeof r.bank_name === 'string' ? r.bank_name : null,
      score,
    });
  }
  return out;
}

// ---------- Drain (automations cron) ----------

/** A send refused before the gateway, by a code safe to store. */
export class CsatRefusal extends Error {
  override readonly name = 'CsatRefusal';
  constructor(readonly code: string) {
    super(`case csat refused: ${code}`);
  }
}

export interface CsatClaim {
  id: string;
  accountId: string;
  caseId: string;
  trigger: CsatTrigger;
  contactId: string;
  conversationId: string;
  contactName: string | null;
  bankName: string | null;
  product: string | null;
  templateName: string;
  language: string;
}

export type CsatSendResult =
  | {
      outcome: 'sent';
      via: 'template' | 'text';
      providerMessageId: string | null;
      messageId: string | null;
    }
  | { outcome: 'held'; reason: string };

export type CsatSender = (
  db: SupabaseClient,
  claim: CsatClaim
) => Promise<CsatSendResult>;

export interface CsatDrainSummary {
  claimed: number;
  sent: number;
  held: number;
  failed: number;
}

/**
 * Requests sent per 5-minute pass. Near-identical messages sent back to
 * back get a linked-device number restricted, so a backlog goes out slowly.
 */
export const CSAT_CLAIM_LIMIT = 5;

/**
 * Claim what may go now (SQL re-checks everything) and send each once. A
 * send that throws is marked failed with a code (a CsatRefusal) or the
 * error's name, never its text; a claim never marked turns
 * 'unconfirmed' in SQL and is never resent. Never throws.
 */
export async function runCaseCsat(
  db: SupabaseClient,
  send: CsatSender,
  now: () => Date = () => new Date()
): Promise<CsatDrainSummary | null> {
  const summary: CsatDrainSummary = { claimed: 0, sent: 0, held: 0, failed: 0 };
  try {
    const c = await db.rpc('case_csat_claim', {
      p_now: now().toISOString(),
      p_limit: CSAT_CLAIM_LIMIT,
    });
    if (c.error) throw c.error;
    const rows = (Array.isArray(c.data) ? c.data : []) as Record<
      string,
      unknown
    >[];
    summary.claimed = rows.length;
    for (const r of rows) {
      const claim: CsatClaim = {
        id: String(r.id),
        accountId: String(r.account_id),
        caseId: String(r.case_id),
        trigger: r.trigger === 'approved' ? 'approved' : 'submitted',
        contactId: String(r.contact_id),
        conversationId: String(r.conversation_id),
        contactName: typeof r.contact_name === 'string' ? r.contact_name : null,
        bankName: typeof r.bank_name === 'string' ? r.bank_name : null,
        product: typeof r.product === 'string' ? r.product : null,
        templateName: String(
          r.template_name ??
            (r.trigger === 'approved'
              ? CSAT_DEFAULTS.templateApproved
              : CSAT_DEFAULTS.templateSubmitted)
        ),
        language: String(r.language ?? 'en'),
      };
      let args: {
        p_outcome: 'sent' | 'failed' | 'held';
        p_via: string | null;
        p_provider_message_id: string | null;
        p_message_id: string | null;
        p_reason: string | null;
      };
      try {
        const res = await send(db, claim);
        args =
          res.outcome === 'sent'
            ? {
                p_outcome: 'sent',
                p_via: res.via,
                p_provider_message_id: res.providerMessageId,
                p_message_id: res.messageId,
                p_reason: null,
              }
            : {
                p_outcome: 'held',
                p_via: null,
                p_provider_message_id: null,
                p_message_id: null,
                p_reason: res.reason,
              };
      } catch (err) {
        args = {
          p_outcome: 'failed',
          p_via: null,
          p_provider_message_id: null,
          p_message_id: null,
          p_reason:
            err instanceof CsatRefusal
              ? err.code
              : err instanceof Error
                ? err.name.toLowerCase()
                : 'error',
        };
      }
      const m = await db.rpc('case_csat_mark', {
        p_id: claim.id,
        ...args,
        p_now: now().toISOString(),
      });
      if (m.error)
        console.error('[cases] csat mark failed', m.error.code ?? '');
      if (args.p_outcome === 'sent') summary.sent += 1;
      else if (args.p_outcome === 'held') summary.held += 1;
      else summary.failed += 1;
    }
    return summary;
  } catch (err) {
    console.error(
      `[cases] csat run failed: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  }
}

// ---------- Reply capture (inbound pipeline) ----------

/**
 * Records a rating reply. Costs nothing unless the text parses as a
 * rating; then one call, which answers false when the workspace has CSAT
 * off or no request is open for the person. True when this message was
 * stored as the answer (the caller treats it as consumed). Never throws.
 */
export async function noteCsatReply(
  db: Pick<SupabaseClient, 'rpc'>,
  input: {
    accountId: string;
    contactId: string;
    messageRowId: string | null;
    text: string | null | undefined;
  }
): Promise<boolean> {
  const reply = parseCsatReply(input.text);
  if (!reply) return false;
  try {
    const { data, error } = await db.rpc('case_csat_capture', {
      p_account: input.accountId,
      p_contact: input.contactId,
      p_message: input.messageRowId,
      p_score: reply.score,
      p_comment: reply.comment,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
