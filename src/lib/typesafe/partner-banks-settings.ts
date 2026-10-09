/**
 * Server side of Settings → AI safety checks → Partner banks: the
 * built-in catalogue as the panel shows it, and validation of a PUT's
 * `partner_banks`. Pure: the settings route owns the database.
 *
 * Validation is strict where `parsePartnerBanks` is tolerant: a stored
 * value is read leniently (dropping what it cannot use), but an admin's
 * submission that is malformed, over a limit or names an unknown code
 * is refused with a 400 rather than silently trimmed.
 */
import { BANKS, type BankEntry } from './banks';
import {
  PARTNER_BANKS_LIMITS,
  parsePartnerBanks,
  type BankCatalogueEntry,
  type PartnerBanksSetting,
} from './admin-types';

/**
 * "first abu dhabi bank" + FAB → "First Abu Dhabi Bank (FAB)": the
 * first English name title-cased, a word spelled like an acronym in
 * capitals ("adcb" → "ADCB", not "ADCB (ADCB)"), then the acronym.
 */
export function bankDisplayName(bank: BankEntry): string {
  if (bank.displayName?.trim()) return bank.displayName.trim();
  const upper = new Set(bank.acronyms ?? []);
  const name = (bank.names[0] ?? bank.code)
    .split(' ')
    .map((w) =>
      upper.has(w.toUpperCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(' ');
  const acronym = bank.acronyms?.[0];
  return acronym && !name.split(' ').includes(acronym)
    ? `${name} (${acronym})`
    : name;
}

export function bankCatalogue(
  banks: readonly BankEntry[] = BANKS
): BankCatalogueEntry[] {
  return banks.map((b) => ({
    code: b.code,
    name: bankDisplayName(b),
    defaultPartner: b.partner,
  }));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type Parsed =
  | { ok: true; value: PartnerBanksSetting | null }
  | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

/** A string of at most PARTNER_BANKS_LIMITS.chars once trimmed. */
const validText = (v: unknown) =>
  typeof v === 'string' && v.trim().length <= PARTNER_BANKS_LIMITS.chars;

/**
 * Validates a PUT body's `partner_banks`: null (back to the built-in
 * list) or `{ codes: string[], custom?: [{ name, aliases? }] }` within
 * PARTNER_BANKS_LIMITS, every code a catalogue code. The accepted value
 * is normalised by parsePartnerBanks (trimmed, deduplicated, codes
 * uppercased).
 */
export function parsePartnerBanksUpdate(
  raw: unknown,
  banks: readonly BankEntry[] = BANKS
): Parsed {
  if (raw === null) return { ok: true, value: null };
  const { customBanks, aliasesPerBank, chars } = PARTNER_BANKS_LIMITS;
  const shape =
    '"partner_banks" must be null or { codes: string[], custom: [{ name, aliases }] }';
  if (!isRecord(raw) || !Array.isArray(raw.codes)) return fail(shape);
  if (raw.custom !== undefined && !Array.isArray(raw.custom))
    return fail(shape);
  const custom = (raw.custom ?? []) as unknown[];

  if (raw.codes.length > customBanks)
    return fail(`At most ${customBanks} built-in banks`);
  const known = new Set(banks.map((b) => b.code));
  for (const code of raw.codes) {
    if (typeof code !== 'string') return fail(shape);
    if (!known.has(code.trim().toUpperCase()))
      return fail(`Unknown bank code "${code.slice(0, chars)}"`);
  }

  if (custom.length > customBanks)
    return fail(`At most ${customBanks} other banks`);
  for (const entry of custom) {
    if (!isRecord(entry) || typeof entry.name !== 'string') return fail(shape);
    if (!entry.name.trim()) return fail('Every other bank needs a name');
    if (!validText(entry.name))
      return fail(`Bank names are at most ${chars} characters`);
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases)) return fail(shape);
    if (aliases.length > aliasesPerBank)
      return fail(`At most ${aliasesPerBank} other names per bank`);
    for (const a of aliases) {
      if (typeof a !== 'string') return fail(shape);
      if (!validText(a))
        return fail(`Other names are at most ${chars} characters`);
    }
  }
  return { ok: true, value: parsePartnerBanks(raw) };
}
