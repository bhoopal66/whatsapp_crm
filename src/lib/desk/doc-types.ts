/**
 * Document types on the desk's forms: a doc key ('trade_licence') is
 * stored and sent, a label ('Trade licence') is what a person reads.
 *
 * Label sources, in order: the workspace's own labels (`case_doc_requirements`
 * rows, registered once the desk has fetched them), the built-in names of
 * the common UAE bank documents, then the key made readable. A key is
 * never shown raw.
 */

/** The built-in names; `case_doc_requirements.label` overrides them. */
export const BUILTIN_DOC_LABELS: Readonly<Record<string, string>> = {
  trade_licence: 'Trade licence',
  ejari: 'Ejari',
  moa: 'Memorandum of association',
  poa: 'Power of attorney',
  emirates_id: 'Emirates ID',
  passport: 'Passport',
  visa: 'Residence visa',
  vat_certificate: 'VAT certificate',
  bank_statement: 'Bank statement',
  noc: 'No objection certificate',
};

/** Words that stay upper-case when a key is made readable. */
const ACRONYMS = new Set(['id', 'moa', 'poa', 'vat', 'noc', 'tin', 'iban']);

/** 'trade_licence' -> 'Trade licence', 'owner_id_copy' -> 'Owner ID copy'. */
export function humaniseDocKey(key: string): string {
  const words = key
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  if (words.length === 0) return key.trim();
  return words
    .map((w, i) =>
      ACRONYMS.has(w)
        ? w.toUpperCase()
        : i === 0
          ? w[0]!.toUpperCase() + w.slice(1)
          : w
    )
    .join(' ');
}

export interface DocType {
  key: string;
  label: string;
}

let registered = new Map<string, string>();

/** Remember the workspace's own labels (replaces the previous set). */
export function registerDocTypes(types: readonly DocType[]): void {
  registered = new Map(types.map((t) => [t.key, t.label]));
}

/** The label of a doc key; a missing key reads as an empty string. */
export function docTypeLabel(key: string | null | undefined): string {
  if (!key) return '';
  return registered.get(key) ?? BUILTIN_DOC_LABELS[key] ?? humaniseDocKey(key);
}

/**
 * Merge label rows from the workspace's requirement lists (first label
 * for a key wins, in the order given) and spec-only keys into one list,
 * sorted by label. Rows with an invalid key are dropped (123's rule).
 */
export function mergeDocTypes(
  labelled: readonly { key: unknown; label: unknown }[],
  specKeys: readonly unknown[]
): DocType[] {
  const valid = (k: unknown): k is string =>
    typeof k === 'string' && /^[a-z0-9_]{1,64}$/.test(k);
  const out = new Map<string, string>();
  for (const r of labelled) {
    if (!valid(r.key) || out.has(r.key)) continue;
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    out.set(r.key, label || BUILTIN_DOC_LABELS[r.key] || humaniseDocKey(r.key));
  }
  for (const k of specKeys) {
    if (valid(k) && !out.has(k))
      out.set(k, BUILTIN_DOC_LABELS[k] ?? humaniseDocKey(k));
  }
  return [...out.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The pick-list options for a form. A value already chosen (from a
 * caption, or an older upload) that is not in the list stays pickable,
 * labelled the same way, so editing never drops it silently.
 */
export function docTypeOptions(
  types: readonly DocType[],
  current: string
): { value: string; label: string }[] {
  const options = types.map((t) => ({ value: t.key, label: t.label }));
  if (current && !types.some((t) => t.key === current))
    options.unshift({ value: current, label: docTypeLabel(current) });
  return options;
}
