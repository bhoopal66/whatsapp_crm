/**
 * The Partner banks card's editing logic (Settings → AI safety checks).
 * Client-safe: imports only the import-free contract. A draft is the
 * value the card would save — null meaning the built-in list — so
 * "Reset to default" is simply null.
 */
import {
  PARTNER_BANKS_LIMITS,
  type BankCatalogueEntry,
  type KnowledgeBankMention,
  type PartnerBanksSetting,
} from './admin-types';

export type PartnerBanksDraft = PartnerBanksSetting | null;

/** The ticked catalogue codes: the built-in partners while null. */
export function effectiveCodes(
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[]
): string[] {
  return (
    draft?.codes ?? catalogue.filter((b) => b.defaultPartner).map((b) => b.code)
  );
}

/** The draft as an explicit list, starting from the built-in one. */
function explicit(
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[]
): PartnerBanksSetting {
  return draft ?? { codes: effectiveCodes(null, catalogue), custom: [] };
}

export function setCode(
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[],
  code: string,
  on: boolean
): PartnerBanksSetting {
  const d = explicit(draft, catalogue);
  const codes = d.codes.filter((c) => c !== code);
  return { ...d, codes: on ? [...codes, code] : codes };
}

export type AddCustomResult =
  | { ok: true; value: PartnerBanksSetting }
  | { ok: false; reason: 'blank' | 'duplicate' | 'limit' };

/**
 * Adds a bank the catalogue does not know. `otherNames` is the
 * comma-separated field ("FAB, First Gulf"); blank and repeated names
 * are dropped and the lists cut to the server's limits.
 */
export function addCustomBank(
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[],
  name: string,
  otherNames: string
): AddCustomResult {
  const { chars, customBanks, aliasesPerBank } = PARTNER_BANKS_LIMITS;
  const clean = name.trim().slice(0, chars).trim();
  if (!clean) return { ok: false, reason: 'blank' };
  const d = explicit(draft, catalogue);
  if (d.custom.some((c) => c.name.toLowerCase() === clean.toLowerCase()))
    return { ok: false, reason: 'duplicate' };
  if (d.custom.length >= customBanks) return { ok: false, reason: 'limit' };
  const seen = new Set([clean.toLowerCase()]);
  const aliases: string[] = [];
  for (const raw of otherNames.split(',')) {
    const a = raw.trim().slice(0, chars).trim();
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    aliases.push(a);
    if (aliases.length >= aliasesPerBank) break;
  }
  return {
    ok: true,
    value: { ...d, custom: [...d.custom, { name: clean, aliases }] },
  };
}

export function removeCustomBank(
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[],
  name: string
): PartnerBanksSetting {
  const d = explicit(draft, catalogue);
  return { ...d, custom: d.custom.filter((c) => c.name !== name) };
}

/** Same saved meaning: code order does not matter, custom order does. */
export function samePartnerBanks(
  a: PartnerBanksDraft,
  b: PartnerBanksDraft
): boolean {
  if (a === null || b === null) return a === b;
  const codes = (s: PartnerBanksSetting) => [...s.codes].sort().join('\n');
  return (
    codes(a) === codes(b) &&
    JSON.stringify(a.custom) === JSON.stringify(b.custom)
  );
}

/** Knowledge-base banks the draft does not yet treat as partners. */
export function untickedMentions(
  mentions: readonly KnowledgeBankMention[],
  draft: PartnerBanksDraft,
  catalogue: readonly BankCatalogueEntry[]
): KnowledgeBankMention[] {
  const ticked = new Set(effectiveCodes(draft, catalogue));
  return mentions.filter((m) => !ticked.has(m.code));
}
