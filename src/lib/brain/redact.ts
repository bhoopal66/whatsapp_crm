/**
 * Ported from wacrm module 022a (second brain): redaction before anything
 * reaches the brain. Reuses the 019b redactor (lib/memory/redact.ts: emails,
 * IBANs, Emirates IDs, cards, OTPs, account / passport numbers, phones ->
 * [PHONE:nnn]) and then masks as [ID] every remaining run of 9 or more digits
 * (any Unicode decimal digits, up to two of '-', '.', '/', '(', ')' or
 * whitespace between them): identity, licence and reference numbers the 019b patterns do not know (a
 * bare 15-digit ID that is not 784-..., a phone in an unknown format).
 * Fails closed: a 019b refusal stores nothing.
 * The same 9-digit rule is enforced again in SQL (brain_item_upsert refuses
 * TEXT_UNREDACTED).
 */
import { redact } from '@/lib/memory/redact';

export type BrainRedactResult =
  { ok: true; text: string } | { ok: false; reason: string };

// Must mask at least everything the SQL guard refuses (ASCII, Arabic-Indic,
// extended Arabic-Indic and full-width digits, up to two of - . / ( ) or
// whitespace between them), or redacted text is refused at ingest.
const LONG_NUMBER = /\p{Nd}(?:[-./()\s]{0,2}\p{Nd}){8,}/gu;

export function brainRedact(input: string): BrainRedactResult {
  const r = redact(input);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, text: r.text.replace(LONG_NUMBER, '[ID]') };
}
