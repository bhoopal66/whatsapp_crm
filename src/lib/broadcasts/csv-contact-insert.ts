/**
 * The `contacts` insert row for a contact first seen in a broadcast's
 * CSV (or Compass slice) audience. Contacts already in the CRM are
 * matched by phone and never touched, so only new rows carry the
 * `broadcast` lead source (migration 249).
 */
export interface CsvContactInput {
  phone: string;
  name?: string | null;
  company?: string | null;
}

export function buildCsvContactInsert(
  userId: string,
  accountId: string,
  row: CsvContactInput
) {
  return {
    user_id: userId,
    account_id: accountId,
    phone: row.phone,
    name: row.name ?? null,
    company: row.company ?? null,
    lead_source: 'broadcast' as const,
  };
}
