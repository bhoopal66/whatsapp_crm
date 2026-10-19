/**
 * Ported from wacrm module 019c (vault), reference package 2026-10-18.
 * Shared vault types, kept out of the (later) database store so the pure modules (tokenize.ts) and the store import
 * them from one place. A `workspace` anywhere in the vault means the wacrm account id (accounts.id).
 */

/** What a vault item belongs to: a contact (contacts.id) or a case (the reference store's shape). */
export interface VaultSubject {
  readonly type: 'contact' | 'case';
  readonly id: string;
}
