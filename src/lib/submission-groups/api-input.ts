/**
 * Public API (v1) input and wire shape for Submission Groups (module 018a).
 * Pure: the routes in src/app/api/v1/submission-groups do the I/O.
 *
 * The submission application names staff by login email and the customer
 * by phone; this module validates that, matches the emails to the rows
 * sg_staff_by_email returned, picks the hosting Whapi number by the
 * allocation rule (migration 060), and shapes the response.
 */
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { hasMinRole, isAccountRole } from '@/lib/auth/roles';
import {
  pickChannelForUser,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import type { StaffLabel } from './rules';
import type { SubmissionGroup } from './store';

export const SUBMISSION_ID_MAX = 128;
export const CUSTOMER_NAME_MAX = 200;
export const SUBJECT_MAX = 100;
export const SUBMISSION_STATUS_MAX = 64;
export const PRODUCT_MAX = 200;
const EMAIL_MAX = 254;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const BANK_CODE_RE = /^[A-Z0-9_]{2,32}$/;
// numeric(18, 2): at most 16 integer digits and 2 decimals.
const AMOUNT_RE = /^(\d{1,16})(?:\.(\d{1,2}))?$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export type StaffField =
  'agent_email' | 'coordinator_email' | 'team_lead_email';

export interface StaffRequest {
  field: StaffField;
  email: string;
  label: StaffLabel;
}

export interface CreateInput {
  submissionId: string;
  customerPhone: string;
  customerName: string | null;
  staff: StaffRequest[];
  coordinatorPhone: string | null;
  subject: string;
  channelId: string | null;
  /** The case's bank code (upper-cased), product and AED amount (decimal string). */
  bankCode: string | null;
  product: string | null;
  amount: string | null;
}

const STAFF_FIELDS: readonly [StaffField, StaffLabel][] = [
  ['agent_email', 'agent'],
  ['coordinator_email', 'coordinator'],
  ['team_lead_email', 'team_lead'],
];

const bad = (message: string) => ({ ok: false as const, message });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

/** "<customer name or phone> · <submission id>", cut to the subject limit. */
export function defaultSubject(
  customerName: string | null,
  customerPhone: string,
  submissionId: string
): string {
  return `${customerName ?? customerPhone} · ${submissionId}`.slice(
    0,
    SUBJECT_MAX
  );
}

function parseEmail(v: unknown, field: string): Parsed<string> {
  if (typeof v !== 'string') return bad(`'${field}' must be a string`);
  const email = v.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email))
    return bad(`'${field}' must be an email address`);
  return { ok: true, value: email };
}

/** A non-negative amount below 10^16 with at most 2 decimals → its decimal string. */
function parseAmount(v: unknown): Parsed<string> {
  const text =
    typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : typeof v === 'string'
        ? v.trim()
        : '';
  const m = AMOUNT_RE.exec(text);
  if (!m)
    return bad(
      "'amount' must be a non-negative number below 10^16 with at most 2 decimals"
    );
  const whole = m[1].replace(/^0+(?=\d)/, '');
  return { ok: true, value: m[2] ? `${whole}.${m[2]}` : whole };
}

/** A bank code, trimmed and upper-cased. */
function parseBank(v: unknown): Parsed<string> {
  const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!BANK_CODE_RE.test(code))
    return bad("'bank' must be a bank code of 2 to 32 letters, digits or _");
  return { ok: true, value: code };
}

/** A product name, 1 to PRODUCT_MAX characters after trimming. */
function parseProduct(v: unknown): Parsed<string> {
  const given = typeof v === 'string' ? v.trim() : '';
  if (!given || given.length > PRODUCT_MAX)
    return bad(`'product' must be 1 to ${PRODUCT_MAX} characters`);
  return { ok: true, value: given };
}

/** POST body → CreateInput, or a 400 message naming the field. */
export function parseCreateInput(body: unknown): Parsed<CreateInput> {
  if (!isObject(body)) return bad('Request body must be a JSON object');

  if (typeof body.submission_id !== 'string')
    return bad("'submission_id' is required");
  const submissionId = body.submission_id.trim();
  if (!submissionId || submissionId.length > SUBMISSION_ID_MAX)
    return bad(`'submission_id' must be 1 to ${SUBMISSION_ID_MAX} characters`);

  if (!isObject(body.customer)) return bad("'customer' is required");
  const rawPhone = body.customer.phone;
  if (typeof rawPhone !== 'string' || !rawPhone.trim())
    return bad("'customer.phone' is required");
  const phone = validateContactPhone(rawPhone, "'customer.phone'");
  if (!phone.ok) return bad(phone.error);
  let customerName: string | null = null;
  if (!absent(body.customer.name)) {
    if (typeof body.customer.name !== 'string')
      return bad("'customer.name' must be a string");
    customerName = body.customer.name.trim() || null;
    if (customerName && customerName.length > CUSTOMER_NAME_MAX)
      return bad(
        `'customer.name' must be at most ${CUSTOMER_NAME_MAX} characters`
      );
  }

  if (absent(body.agent_email)) return bad("'agent_email' is required");
  const staff: StaffRequest[] = [];
  for (const [field, label] of STAFF_FIELDS) {
    if (absent(body[field])) continue;
    const email = parseEmail(body[field], field);
    if (!email.ok) return email;
    staff.push({ field, email: email.value, label });
  }

  let coordinatorPhone: string | null = null;
  if (!absent(body.coordinator_phone)) {
    if (typeof body.coordinator_phone !== 'string')
      return bad("'coordinator_phone' must be a string");
    const checked = validateContactPhone(
      body.coordinator_phone,
      "'coordinator_phone'"
    );
    if (!checked.ok) return bad(checked.error);
    coordinatorPhone = checked.normalized.replace(/\D/g, '');
  }

  let subject = defaultSubject(customerName, phone.normalized, submissionId);
  if (!absent(body.subject)) {
    if (typeof body.subject !== 'string')
      return bad("'subject' must be a string");
    const given = body.subject.trim();
    if (given.length > SUBJECT_MAX)
      return bad(`'subject' must be at most ${SUBJECT_MAX} characters`);
    if (given) subject = given;
  }

  let channelId: string | null = null;
  if (!absent(body.channel_id)) {
    if (typeof body.channel_id !== 'string' || !UUID_RE.test(body.channel_id))
      return bad("'channel_id' must be a UUID");
    channelId = body.channel_id.toLowerCase();
  }

  let bankCode: string | null = null;
  if (!absent(body.bank)) {
    const parsedBank = parseBank(body.bank);
    if (!parsedBank.ok) return parsedBank;
    bankCode = parsedBank.value;
  }

  let product: string | null = null;
  if (!absent(body.product)) {
    const parsedProduct = parseProduct(body.product);
    if (!parsedProduct.ok) return parsedProduct;
    product = parsedProduct.value;
  }

  let amount: string | null = null;
  if (!absent(body.amount)) {
    const parsedAmount = parseAmount(body.amount);
    if (!parsedAmount.ok) return parsedAmount;
    amount = parsedAmount.value;
  }

  return {
    ok: true,
    value: {
      submissionId,
      customerPhone: phone.normalized,
      customerName,
      staff,
      coordinatorPhone,
      subject,
      channelId,
      bankCode,
      product,
      amount,
    },
  };
}

export const OUTCOME_TEXT_MAX = 500;
export const COMPASS_URL_MAX = 2048;
export const PATCH_DOCUMENTS_MAX = 100;
const DOC_KEY_RE = /^[a-z0-9_]{1,64}$/;
const DOC_STATUSES = ['requested', 'received', 'rejected'] as const;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SYNC_KEYS = [
  'changed_at',
  'stage',
  'outcome_reason',
  'bank',
  'product',
  'amount',
  'compass_url',
  'documents',
] as const;

/** p_patch of case_sync_from_submission (migration 134); every key optional. */
export interface CaseSyncPatch {
  stage?: string;
  outcome_code?: string;
  outcome_text?: string;
  bank?: string;
  product?: string;
  amount?: string;
  external_url?: string;
  documents?: {
    key: string;
    status: (typeof DOC_STATUSES)[number];
    file_ref?: string;
    received_at?: string;
  }[];
}

export interface PatchInput {
  /** The reported submission status, or null when the body syncs the case only. */
  status: string | null;
  /** Present only when the body carries a case-sync key (migration 134). */
  sync?: { changedAt: string | null; patch: CaseSyncPatch };
}

/** An ISO 8601 date-time → its ISO string, or null when it is not one. */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function parseSync(body: Record<string, unknown>): Parsed<PatchInput['sync']> {
  const patch: CaseSyncPatch = {};
  let changedAt: string | null = null;
  if (!absent(body.changed_at)) {
    changedAt = isoDate(body.changed_at);
    if (!changedAt) return bad("'changed_at' must be an ISO 8601 date-time");
  }
  if (!absent(body.stage)) {
    const stage = typeof body.stage === 'string' ? body.stage.trim() : '';
    if (!stage || stage.length > SUBMISSION_STATUS_MAX)
      return bad(`'stage' must be 1 to ${SUBMISSION_STATUS_MAX} characters`);
    patch.stage = stage;
  }
  if (!absent(body.outcome_reason)) {
    const r = body.outcome_reason;
    if (!isObject(r) || typeof r.code !== 'string' || !r.code.trim())
      return bad("'outcome_reason.code' is required");
    patch.outcome_code = r.code.trim().toUpperCase();
    if (!absent(r.text)) {
      if (typeof r.text !== 'string')
        return bad("'outcome_reason.text' must be a string");
      const text = r.text.trim();
      if (text.length > OUTCOME_TEXT_MAX)
        return bad(
          `'outcome_reason.text' must be at most ${OUTCOME_TEXT_MAX} characters`
        );
      if (text) patch.outcome_text = text;
    }
  }
  if (!absent(body.bank)) {
    const bank = parseBank(body.bank);
    if (!bank.ok) return bank;
    patch.bank = bank.value;
  }
  if (!absent(body.product)) {
    const product = parseProduct(body.product);
    if (!product.ok) return product;
    patch.product = product.value;
  }
  if (!absent(body.amount)) {
    const amount = parseAmount(body.amount);
    if (!amount.ok) return amount;
    patch.amount = amount.value;
  }
  if (!absent(body.compass_url)) {
    const url =
      typeof body.compass_url === 'string' ? body.compass_url.trim() : '';
    if (
      !/^https:\/\/\S+$/.test(url) ||
      url.length > COMPASS_URL_MAX ||
      !URL.canParse(url)
    )
      return bad(
        `'compass_url' must be an https URL of at most ${COMPASS_URL_MAX} characters`
      );
    patch.external_url = url;
  }
  if (!absent(body.documents)) {
    if (!Array.isArray(body.documents))
      return bad("'documents' must be an array");
    if (body.documents.length > PATCH_DOCUMENTS_MAX)
      return bad(`'documents' must have at most ${PATCH_DOCUMENTS_MAX} items`);
    const docs: NonNullable<CaseSyncPatch['documents']> = [];
    for (const [i, d] of body.documents.entries()) {
      const at = `'documents[${i}]`;
      if (!isObject(d)) return bad(`${at}' must be an object`);
      if (typeof d.key !== 'string' || !DOC_KEY_RE.test(d.key))
        return bad(`${at}.key' must be 1 to 64 of a-z, 0-9 or _`);
      if (!(DOC_STATUSES as readonly unknown[]).includes(d.status))
        return bad(`${at}.status' must be requested, received or rejected`);
      const doc: NonNullable<CaseSyncPatch['documents']>[number] = {
        key: d.key,
        status: d.status as (typeof DOC_STATUSES)[number],
      };
      if (!absent(d.file_ref)) {
        if (typeof d.file_ref !== 'string' || !d.file_ref.trim())
          return bad(`${at}.file_ref' must be a non-empty string`);
        doc.file_ref = d.file_ref.trim();
      }
      if (!absent(d.received_at)) {
        const receivedAt = isoDate(d.received_at);
        if (!receivedAt)
          return bad(`${at}.received_at' must be an ISO 8601 date-time`);
        doc.received_at = receivedAt;
      }
      docs.push(doc);
    }
    patch.documents = docs;
  }
  return { ok: true, value: { changedAt, patch } };
}

/**
 * PATCH body → the reported submission status (1–64 characters, trimmed)
 * and, when any case-sync key is present (migration 134: changed_at,
 * stage, outcome_reason, bank, product, amount, compass_url, documents),
 * the patch for case_sync_from_submission. A body with no sync key
 * parses exactly as before: `status` is required and the value is
 * `{ status }`.
 */
export function parsePatchInput(body: unknown): Parsed<PatchInput> {
  if (!isObject(body)) return bad('Request body must be a JSON object');
  const syncing = SYNC_KEYS.some((k) => !absent(body[k]));
  if (!syncing || !absent(body.status)) {
    if (typeof body.status !== 'string') return bad("'status' is required");
  }
  let status: string | null = null;
  if (typeof body.status === 'string') {
    status = body.status.trim();
    if (!status || status.length > SUBMISSION_STATUS_MAX)
      return bad(`'status' must be 1 to ${SUBMISSION_STATUS_MAX} characters`);
  }
  if (!syncing) return { ok: true, value: { status: status! } };
  const sync = parseSync(body);
  if (!sync.ok) return sync;
  return { ok: true, value: { status, sync: sync.value } };
}

/** A row of sg_staff_by_email. */
export interface StaffRow {
  email: string;
  user_id: string;
  role: string;
  full_name: string | null;
}

export interface ResolvedStaff {
  userId: string;
  email: string;
  label: StaffLabel;
  role: string;
}

export type StaffResolution =
  | { ok: true; staff: ResolvedStaff[] }
  | { ok: false; code: 'unknown_user'; field: StaffField }
  | { ok: false; code: 'duplicate_user'; fields: StaffField[] };

/** Matches each requested email to an eligible staff row; one person may hold one label only. */
export function resolveStaff(
  requested: readonly StaffRequest[],
  rows: readonly StaffRow[]
): StaffResolution {
  const byEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r]));
  const staff: ResolvedStaff[] = [];
  for (const req of requested) {
    const row = byEmail.get(req.email);
    if (!row) return { ok: false, code: 'unknown_user', field: req.field };
    const dup = staff.findIndex((s) => s.userId === row.user_id);
    if (dup >= 0)
      return {
        ok: false,
        code: 'duplicate_user',
        fields: [requested[dup].field, req.field],
      };
    staff.push({
      userId: row.user_id,
      email: req.email,
      label: req.label,
      role: row.role,
    });
  }
  return { ok: true, staff };
}

export interface ChannelMemberRow {
  config_id: string;
  user_id: string;
}

export type HostingChoice =
  | { ok: true; channel: WhatsAppChannel }
  | { ok: false; code: 'no_whapi_number' | 'channel_not_allowed' };

/**
 * The Whapi number that hosts the group. A number with allocation rows
 * (whatsapp_channel_members) is usable by those people and by owners and
 * admins; a number with none is shared. Without `requestedId` the agent's
 * own number is picked as a new chat would be (pickChannelForUser) — and
 * refused if even that one is not theirs to use.
 */
export function chooseHostingNumber(input: {
  channels: readonly WhatsAppChannel[];
  members: readonly ChannelMemberRow[];
  agentUserId: string;
  agentRole: string;
  requestedId: string | null;
}): HostingChoice {
  const whapi = input.channels.filter((c) => c.provider === 'whapi');
  if (whapi.length === 0) return { ok: false, code: 'no_whapi_number' };
  const isAdmin =
    isAccountRole(input.agentRole) && hasMinRole(input.agentRole, 'admin');
  const allocated = new Map<string, Set<string>>();
  for (const m of input.members) {
    const set = allocated.get(m.config_id) ?? new Set<string>();
    set.add(m.user_id);
    allocated.set(m.config_id, set);
  }
  const usable = (c: WhatsAppChannel) =>
    isAdmin ||
    !allocated.has(c.id) ||
    allocated.get(c.id)!.has(input.agentUserId);

  if (input.requestedId !== null) {
    const asked = whapi.find((c) => c.id === input.requestedId);
    return asked && usable(asked)
      ? { ok: true, channel: asked }
      : { ok: false, code: 'channel_not_allowed' };
  }
  const mine = whapi
    .filter((c) => allocated.get(c.id)?.has(input.agentUserId))
    .map((c) => c.id);
  const routed = whapi.find((c) => c.isPrimary) ?? whapi[0];
  const shared = isAdmin
    ? undefined
    : new Set(whapi.filter((c) => !allocated.has(c.id)).map((c) => c.id));
  const picked = pickChannelForUser([...whapi], mine, routed, shared);
  return usable(picked)
    ? { ok: true, channel: picked }
    : { ok: false, code: 'channel_not_allowed' };
}

const digits = (s: string) => s.replace(/@.*$/, '').replace(/\D/g, '');

/** True when WhatsApp refused to add this phone (refused entries are wa ids or JIDs). */
export function phoneWasRefused(
  refused: readonly string[],
  phone: string
): boolean {
  const want = digits(phone);
  return want !== '' && refused.some((r) => digits(r) === want);
}

/** The invite code of a https://chat.whatsapp.com/<code> link, or null. */
export function inviteCodeOf(link: string | null): string | null {
  const m = link?.match(/^https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

export interface AccessEntry {
  userId: string;
  label: string;
  email?: string;
}

/** The group's case (module 018c) as the v1 API shows it; null when it could not be read. */
export type CaseWire = Record<string, unknown> | null;

export interface WireExtras {
  refusedParticipants?: readonly string[];
  inviteSent?: boolean;
  error?: string;
  /** Absent: no `case` key (GET); null: the case step failed. */
  case?: CaseWire;
}

/** The v1 wire shape of a group. */
export function serializeGroup(
  group: SubmissionGroup,
  access: readonly AccessEntry[],
  extras: WireExtras = {}
) {
  return {
    id: group.id,
    submission_id: group.submissionRef,
    status: group.status,
    submission_status: group.submissionStatus,
    channel_id: group.channelId,
    contact_id: group.contactId,
    whatsapp: {
      group_id: group.waGroupId,
      invite_link: group.inviteLink,
      pending: group.waGroupId === null && group.status === 'ACTIVE',
      refused_participants: [...(extras.refusedParticipants ?? [])],
      invite_sent: extras.inviteSent ?? false,
      invite_sent_at: group.inviteSentAt
        ? group.inviteSentAt.toISOString()
        : null,
      ...(extras.error ? { error: extras.error } : {}),
    },
    access: access.map((a) => ({
      ...(a.email ? { email: a.email } : {}),
      user_id: a.userId,
      label: a.label,
    })),
    created_at: group.createdAt.toISOString(),
    ended_at: group.endedAt ? group.endedAt.toISOString() : null,
    ...(extras.case !== undefined ? { case: extras.case } : {}),
  };
}
