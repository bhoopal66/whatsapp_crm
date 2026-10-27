/**
 * Who may direct-message whom (migration 143), as the Settings → Team
 * chat matrix edits it. Pure: the RPC wrappers are in `api.ts`.
 *
 * A rule is per pair of classes and symmetric. The table stores only
 * restricting pairs ('none', 'team'), in canonical order
 * (`class_a <= class_b`, plain text comparison); a missing pair means
 * 'all'. Owners are outside the matrix: they always reach everyone.
 */

/** In display order. Mirrors 143's CHECK on class_a / class_b. */
export const DM_CLASSES = [
  'admin',
  'team_leader',
  'coordinator',
  'agent',
  'viewer',
] as const;
export type DmClass = (typeof DM_CLASSES)[number];

/** Narrowest first. Mirrors 143's CHECK on scope. */
export const DM_SCOPES = ['none', 'team', 'all'] as const;
export type DmScope = (typeof DM_SCOPES)[number];

/** Pair key → scope, one entry per unordered pair (15 of them). */
export type DmMatrix = Readonly<Record<string, DmScope>>;

export interface DmRuleRow {
  class_a: string;
  class_b: string;
  scope: string;
}

const isClass = (v: unknown): v is DmClass =>
  typeof v === 'string' && (DM_CLASSES as readonly string[]).includes(v);
const isScope = (v: unknown): v is DmScope =>
  typeof v === 'string' && (DM_SCOPES as readonly string[]).includes(v);

/** The pair in the table's canonical order (`class_a <= class_b`). */
export function canonicalPair(a: DmClass, b: DmClass): [DmClass, DmClass] {
  return a <= b ? [a, b] : [b, a];
}

/** One key per unordered pair: pairKey(a, b) === pairKey(b, a). */
export function pairKey(a: DmClass, b: DmClass): string {
  return canonicalPair(a, b).join(':');
}

/** Every unordered pair, self-pairs included, in display order. */
export const DM_PAIRS: readonly [DmClass, DmClass][] = DM_CLASSES.flatMap(
  (a, i) => DM_CLASSES.slice(i).map((b) => [a, b] as [DmClass, DmClass])
);

/** Every pair 'all': what a workspace that never saved rules has. */
export function openMatrix(): DmMatrix {
  return Object.fromEntries(DM_PAIRS.map(([a, b]) => [pairKey(a, b), 'all']));
}

/** Stored rows → the full matrix; a missing pair is 'all', a bad row is ignored. */
export function rulesFromRows(rows: readonly DmRuleRow[] | null): DmMatrix {
  const out: Record<string, DmScope> = { ...openMatrix() };
  for (const r of rows ?? []) {
    if (isClass(r.class_a) && isClass(r.class_b) && isScope(r.scope))
      out[pairKey(r.class_a, r.class_b)] = r.scope;
  }
  return out;
}

export const scopeOf = (m: DmMatrix, a: DmClass, b: DmClass): DmScope =>
  m[pairKey(a, b)] ?? 'all';

/** The matrix with one pair changed (both directions, being one key). */
export function withScope(
  m: DmMatrix,
  a: DmClass,
  b: DmClass,
  scope: DmScope
): DmMatrix {
  return { ...m, [pairKey(a, b)]: scope };
}

/**
 * The chat_set_dm_rules payload: the whole set, restricting pairs only
 * (an 'all' row would mean what its absence means), canonical order.
 */
export function rowsToSave(
  m: DmMatrix
): { class_a: DmClass; class_b: DmClass; scope: DmScope }[] {
  return DM_PAIRS.flatMap(([a, b]) => {
    const scope = scopeOf(m, a, b);
    const [x, y] = canonicalPair(a, b);
    return scope === 'all' ? [] : [{ class_a: x, class_b: y, scope }];
  });
}

/** Same rules, whatever the key order. */
export function sameRules(x: DmMatrix, y: DmMatrix): boolean {
  return DM_PAIRS.every(([a, b]) => scopeOf(x, a, b) === scopeOf(y, a, b));
}

/**
 * The owner's requested setup: agents and viewers do not DM one another
 * and reach team leaders of their own team only; admins and coordinators
 * stay reachable by everyone.
 */
export const RECOMMENDED_DM_RULES: DmMatrix = rulesFromRows([
  { class_a: 'agent', class_b: 'agent', scope: 'none' },
  { class_a: 'viewer', class_b: 'viewer', scope: 'none' },
  { class_a: 'agent', class_b: 'viewer', scope: 'none' },
  { class_a: 'agent', class_b: 'team_leader', scope: 'team' },
  { class_a: 'team_leader', class_b: 'viewer', scope: 'team' },
]);
