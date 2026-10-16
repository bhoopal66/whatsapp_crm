// What the customer page (/contacts/[id]) offers a person, by role.
// UI only: RLS decides (migration 059 lets agent and up who can see a
// contact update or delete it; `contacts_opt_out_guard` and
// `contacts_consent_guard` keep clearing an opt-out or moving a
// do-not-contact to admins). Reaching the page at all already means
// RLS handed the contact over, so these flags only shape what is shown.

import {
  canEditSettings,
  canSendMessages,
  hasMinRole,
  type AccountRole,
} from '@/lib/auth/roles';

export interface CustomerAccess {
  /** Edit name, phone, email, company and custom fields. */
  edit: boolean;
  /** Add a note to the customer. */
  addNote: boolean;
  /** Send a WhatsApp message or template. */
  send: boolean;
  /** Dial the customer from the CRM. */
  call: boolean;
  /** Set a do-not-contact where none exists (with a reason). */
  setDoNotContact: boolean;
  /** Clear an opt-out, or move or clear a do-not-contact. */
  manageConsent: boolean;
  /** Delete the contact. Admin and up only, though RLS also lets an
   *  agent who can see the contact delete it: destructive, so the
   *  page keeps it to admins. */
  deleteContact: boolean;
}

const NONE: CustomerAccess = {
  edit: false,
  addNote: false,
  send: false,
  call: false,
  setDoNotContact: false,
  manageConsent: false,
  deleteContact: false,
};

/** Null while the profile loads: nothing, so no action flashes. */
export function customerAccess(
  role: AccountRole | null | undefined
): CustomerAccess {
  if (!role) return NONE;
  // Agent and up work the customer; a viewer reads only, and a bank
  // guest cannot read contacts at all (current_account_id() is NULL).
  const staff = canSendMessages(role);
  const admin = hasMinRole(role, 'admin');
  return {
    edit: staff,
    addNote: staff,
    send: staff,
    call: staff,
    setDoNotContact: staff,
    manageConsent: admin && canEditSettings(role),
    deleteContact: admin,
  };
}
