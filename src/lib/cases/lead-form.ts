/**
 * The customer page's Cases card and its "Open lead" dialog (migration
 * 130): the pure parts. Client-safe: no store, no server import.
 *
 * POST /api/cases/leads takes `{ contactId, bankCode, product, amount?,
 * agentId?, leadSource? }`; the server defaults `agentId` to the signed-in
 * user and the database (case_open_lead) decides who may open for whom, so
 * an agent's form never sends one.
 */
import { normaliseAmount } from './case-page';

export const LEAD_PRODUCT_MAX = 200;

/** The "Lead" chip's colours (inbox rows and the customer page's Cases card). */
export const LEAD_CHIP =
  'bg-sky-500/15 text-sky-700 [[data-mode=dark]_&]:text-sky-300';
export const LEAD_SOURCE_MAX = 200;

export interface LeadFormInput {
  contactId: string;
  bankCode: string;
  product: string;
  /** As typed; empty means none. */
  amount: string;
  /** As typed; empty means none. */
  leadSource: string;
  /** The picked owner; only sent when the person may pick one. */
  agentId: string | null;
  /** Team leader and up (canLeadTeam): may open a lead for another agent. */
  canPickAgent: boolean;
}

export interface LeadRequestBody {
  contactId: string;
  bankCode: string;
  product: string;
  amount?: string;
  leadSource?: string;
  agentId?: string;
}

export type LeadFormError =
  | 'bankRequired'
  | 'productRequired'
  | 'productTooLong'
  | 'amountInvalid'
  | 'sourceTooLong';

/** The route's amount: up to 16 whole digits and 2 decimals. */
const ROUTE_AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;

export function buildLeadRequest(
  input: LeadFormInput
): { ok: true; body: LeadRequestBody } | { ok: false; error: LeadFormError } {
  const bankCode = input.bankCode.trim();
  if (!bankCode) return { ok: false, error: 'bankRequired' };
  const product = input.product.trim();
  if (!product) return { ok: false, error: 'productRequired' };
  if (product.length > LEAD_PRODUCT_MAX)
    return { ok: false, error: 'productTooLong' };

  const body: LeadRequestBody = {
    contactId: input.contactId,
    bankCode,
    product,
  };
  if (input.amount.trim()) {
    const amount = normaliseAmount(input.amount);
    if (amount === null || !ROUTE_AMOUNT.test(amount))
      return { ok: false, error: 'amountInvalid' };
    body.amount = amount;
  }
  const source = input.leadSource.trim();
  if (source) {
    if (source.length > LEAD_SOURCE_MAX)
      return { ok: false, error: 'sourceTooLong' };
    body.leadSource = source;
  }
  if (input.canPickAgent && input.agentId) body.agentId = input.agentId;
  return { ok: true, body };
}

export type LeadErrorKey =
  | 'leadExists'
  | 'caseExists'
  | 'leadInvalid'
  | 'bankUnknown'
  | 'assigneeInvalid'
  | 'generic';

const LEAD_REFUSALS: Record<string, LeadErrorKey> = {
  LEAD_EXISTS: 'leadExists',
  CASE_EXISTS: 'caseExists',
  LEAD_INVALID: 'leadInvalid',
  BANK_UNKNOWN: 'bankUnknown',
  ASSIGNEE_INVALID: 'assigneeInvalid',
};

/** A refused POST /api/cases/leads -> the message key to show. */
export function leadErrorKey(status: number, code: unknown): LeadErrorKey {
  if ((status === 409 || status === 422) && typeof code === 'string')
    return LEAD_REFUSALS[code] ?? 'generic';
  return 'generic';
}

/** The new lead's id from a 201 body, or null. */
export function createdLeadId(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** One row of GET /api/cases/leads?contactId=. */
export interface ContactCase {
  id: string;
  stage: string;
  bankCode: string | null;
  product: string | null;
  /** AED as a decimal string. */
  amount: string | null;
  isLead: boolean;
  openedAt: string | null;
  closedAt: string | null;
}

const optStr = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

/** The contact's cases, tolerant of a missing or malformed body. */
export function parseContactCases(json: unknown): ContactCase[] {
  const list = (json as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(list)) return [];
  const out: ContactCase[] = [];
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    const c = r as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) continue;
    out.push({
      id: c.id,
      stage: optStr(c.stage) ?? '',
      bankCode: optStr(c.bankCode),
      product: optStr(c.product),
      // Exact decimal strings only: a JSON number may already have lost digits.
      amount: optStr(c.amount),
      isLead: c.isLead === true,
      openedAt: optStr(c.openedAt),
      closedAt: optStr(c.closedAt),
    });
  }
  return out;
}
