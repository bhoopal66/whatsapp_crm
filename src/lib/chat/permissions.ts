/**
 * Team-chat role permissions and posting rules (migration 157) and the
 * sensitive-data guard (158), as the screens read them.
 *
 * The database decides: every capability is re-checked by the chat_*
 * RPC that uses it. This module only tells a screen what to hide or
 * grey out, so it is tolerant in one direction: a capability, window or
 * guard setting it cannot read counts as allowed / off. An older
 * database (no 157) therefore never hides a feature that still works.
 *
 * CHAT_CAPABILITIES, CHAT_ROLE_CLASSES and GUEST_CAPABILITIES mirror
 * 157's CHECK lists (permissions.test.ts reads the migration): change
 * one, change both.
 */

export const CHAT_CAPABILITIES = [
  'create_team_channel',
  'create_private_channel',
  'open_group_dm',
  'mention_everyone',
  'upload_files',
  'send_voice',
  'pin_messages',
  'forward_messages',
  'share_cards',
  'add_members',
  'edit_own',
  'delete_own',
] as const;
export type ChatCapability = (typeof CHAT_CAPABILITIES)[number];

/** Owners are never restricted, so they have no class of their own. */
export const CHAT_ROLE_CLASSES = [
  'admin',
  'team_leader',
  'agent',
  'viewer',
  'bank_guest',
] as const;
export type ChatRoleClass = (typeof CHAT_ROLE_CLASSES)[number];

/** The capabilities a bank guest can be denied; the rest they never have. */
export const GUEST_CAPABILITIES = [
  'upload_files',
  'send_voice',
  'pin_messages',
  'forward_messages',
  'mention_everyone',
  'edit_own',
  'delete_own',
] as const satisfies readonly ChatCapability[];

export type ChannelRule = 'everyone' | 'admins';
export type SensitiveMode = 'off' | 'warn' | 'block';
export type SensitiveScope = 'guests' | 'all';

export interface SensitiveGuard {
  mode: SensitiveMode;
  scope: SensitiveScope;
}

export interface ChatPermissions {
  /** The caller's class ('owner' for an owner); null when unreadable. */
  roleClass: string | null;
  can: Record<ChatCapability, boolean>;
  /** Minutes after posting that one's own message may be edited; null = no limit. */
  editWindowMinutes: number | null;
  deleteWindowMinutes: number | null;
  /** False for owners and admins, whom the windows never bind. */
  windowsApply: boolean;
  sensitive: SensitiveGuard;
}

/** One denied (class, capability) pair, the shape chat_set_permissions takes. */
export interface DeniedPair {
  role_class: ChatRoleClass;
  capability: ChatCapability;
}

/** class → capability → allowed. */
export type PermissionMatrix = Record<
  ChatRoleClass,
  Record<ChatCapability, boolean>
>;

const allTrue = (): Record<ChatCapability, boolean> =>
  Object.fromEntries(CHAT_CAPABILITIES.map((c) => [c, true])) as Record<
    ChatCapability,
    boolean
  >;

/** What a screen assumes when nothing could be read. */
export const ALL_ALLOWED: ChatPermissions = Object.freeze({
  roleClass: null,
  can: Object.freeze(allTrue()),
  editWindowMinutes: null,
  deleteWindowMinutes: null,
  windowsApply: false,
  sensitive: Object.freeze({ mode: 'off', scope: 'guests' }),
}) as ChatPermissions;

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function windowOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * chat_my_permissions' jsonb → ChatPermissions. Only an explicit
 * `false` denies a capability; a missing or unknown value is allowed,
 * and an unknown guard mode is off.
 */
export function parseMyPermissions(json: unknown): ChatPermissions {
  if (!isObj(json)) return { ...ALL_ALLOWED, can: allTrue() };
  const caps = isObj(json.capabilities) ? json.capabilities : {};
  const can = allTrue();
  for (const c of CHAT_CAPABILITIES) if (caps[c] === false) can[c] = false;
  const s = isObj(json.sensitive) ? json.sensitive : {};
  const editWindowMinutes = windowOf(json.edit_window_minutes);
  const deleteWindowMinutes = windowOf(json.delete_window_minutes);
  return {
    roleClass: typeof json.role_class === 'string' ? json.role_class : null,
    can,
    editWindowMinutes,
    deleteWindowMinutes,
    // Missing = the windows bind only when one is set: the database
    // enforces them anyway, so showing the limit is the safer guess.
    windowsApply:
      typeof json.windows_apply === 'boolean'
        ? json.windows_apply
        : editWindowMinutes !== null || deleteWindowMinutes !== null,
    sensitive: {
      mode: s.mode === 'warn' || s.mode === 'block' ? s.mode : 'off',
      scope: s.scope === 'all' ? 'all' : 'guests',
    },
  };
}

/**
 * Whether an action limited to `minutes` after `createdAt` is still
 * open at `now`. The database's test is `now() <= created_at + window`,
 * so the boundary instant is still open. No limit (null) is always
 * open; an unparseable timestamp is treated as open (the server decides).
 */
export function windowOpen(
  createdAt: string | Date,
  minutes: number | null,
  now: number | Date = Date.now()
): boolean {
  if (minutes === null) return true;
  const start =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (Number.isNaN(start)) return true;
  const t = now instanceof Date ? now.getTime() : now;
  return t <= start + minutes * 60_000;
}

const isClass = (v: unknown): v is ChatRoleClass =>
  (CHAT_ROLE_CLASSES as readonly unknown[]).includes(v);
const isCapability = (v: unknown): v is ChatCapability =>
  (CHAT_CAPABILITIES as readonly unknown[]).includes(v);

/** True when 157 lets this pair be denied (a guest only for GUEST_CAPABILITIES). */
export function isDeniable(
  roleClass: ChatRoleClass,
  capability: ChatCapability
): boolean {
  return (
    roleClass !== 'bank_guest' ||
    (GUEST_CAPABILITIES as readonly string[]).includes(capability)
  );
}

/**
 * Migration 168's fixed rule for creating team and private channels:
 * a viewer never may ('never'), an agent only while a coordinator
 * ('coordinatorsOnly', so the matrix's agent box governs coordinators).
 * Every other pair is the matrix's alone (null).
 */
export function channelCreationLimit(
  roleClass: ChatRoleClass,
  capability: ChatCapability
): 'never' | 'coordinatorsOnly' | null {
  if (
    capability !== 'create_team_channel' &&
    capability !== 'create_private_channel'
  ) {
    return null;
  }
  if (roleClass === 'viewer') return 'never';
  if (roleClass === 'agent') return 'coordinatorsOnly';
  return null;
}

/** Everything allowed, for every class. */
export function openPermissionMatrix(): PermissionMatrix {
  return Object.fromEntries(
    CHAT_ROLE_CLASSES.map((rc) => [rc, allTrue()])
  ) as PermissionMatrix;
}

/**
 * chat_role_permissions rows (each one a denial) → the matrix. Unknown
 * classes or capabilities are skipped.
 */
export function matrixFromRows(
  rows: readonly { role_class?: unknown; capability?: unknown }[]
): PermissionMatrix {
  const m = openPermissionMatrix();
  for (const r of rows) {
    if (isClass(r.role_class) && isCapability(r.capability)) {
      m[r.role_class][r.capability] = false;
    }
  }
  return m;
}

/**
 * The matrix → chat_set_permissions' whole denied set, in class and
 * capability order. A guest pair 157 refuses is never emitted (a guest
 * never has those capabilities, whatever the matrix says).
 */
export function deniedFromMatrix(matrix: PermissionMatrix): DeniedPair[] {
  const out: DeniedPair[] = [];
  for (const rc of CHAT_ROLE_CLASSES) {
    for (const cap of CHAT_CAPABILITIES) {
      if (matrix[rc]?.[cap] === false && isDeniable(rc, cap)) {
        out.push({ role_class: rc, capability: cap });
      }
    }
  }
  return out;
}

/** The preset a settings screen offers as "Recommended", in deniedFromMatrix order. */
export const RECOMMENDED_DENIED: readonly DeniedPair[] = Object.freeze([
  { role_class: 'agent', capability: 'mention_everyone' },
  ...(
    [
      'create_team_channel',
      'create_private_channel',
      'open_group_dm',
      'mention_everyone',
      'pin_messages',
      'add_members',
    ] as const
  ).map((capability) => ({ role_class: 'viewer' as const, capability })),
  { role_class: 'bank_guest', capability: 'mention_everyone' },
  { role_class: 'bank_guest', capability: 'forward_messages' },
]);
