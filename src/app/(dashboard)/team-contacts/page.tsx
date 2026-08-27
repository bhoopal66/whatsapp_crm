'use client';

import { ContactsPageInner } from '../contacts/page';

/**
 * Team contacts — every customer this team leader's people created or
 * are talking to.
 *
 * Same screen as /contacts with the personal narrowing switched off,
 * so it shows whatever the database will hand a leader: their team's
 * customers (migration 044).
 */
export default function TeamContactsPage() {
  return <ContactsPageInner teamView />;
}
