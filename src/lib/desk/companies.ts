/**
 * Company contacts (migration 229, design 035 D1): the CRM contacts who
 * act for a desk company, with a role and an authorised flag. One phone
 * may act for several companies. A link is a fact, never a grant.
 *
 * Pure: shared by the routes and the desk screen. `companies.test.ts`
 * pins DESK_CONTACT_ROLES to 229's CHECK.
 */

/** How many companies one search answers: 229's desk_customer_find default. */
export const COMPANY_FIND_LIMIT = 20;

export const DESK_CONTACT_ROLES = [
  'owner',
  'pro',
  'accountant',
  'other',
] as const;
export type DeskContactRole = (typeof DESK_CONTACT_ROLES)[number];

export function isDeskContactRole(v: unknown): v is DeskContactRole {
  return (
    typeof v === 'string' &&
    (DESK_CONTACT_ROLES as readonly string[]).includes(v)
  );
}

export interface DeskCompany {
  customerId: string;
  legalName: string;
  tradeLicenceNo: string;
  /** The open application's number, if any. */
  appNumber: string | null;
  contacts: number;
  canManage: boolean;
}

export interface DeskCompanyContact {
  contactId: string;
  name: string | null;
  phone: string | null;
  role: DeskContactRole;
  authorised: boolean;
  /** Linked by the system from a desk case, not by a person. */
  automatic: boolean;
  createdAt: string;
  updatedAt: string;
}
