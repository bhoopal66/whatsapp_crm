// ============================================================
// The workspace UI's logic (migration 083): the "Create a workspace"
// dialog's form, the add-a-person flow in Settings → Members, and the
// unread badges on the workspace rail.
//
// Pure: no I/O and no DOM, so the rules the dialogs enforce are tested
// here rather than by mounting components (the test env has no DOM).
// The server re-checks everything: these rules only spare the person a
// round trip that would bounce.
// ============================================================

import type { AddableRole } from '@/lib/account/add-member';

/** POST /api/workspaces accepts at most this many invites. */
export const MAX_INVITES = 50;

/** create_workspace(): the trimmed name is 1–80 characters. */
export const MAX_WORKSPACE_NAME = 80;

/** create_workspace(): one to four ASCII letters or digits. */
export const SHORT_NAME_PATTERN = /^[A-Za-z0-9]{1,4}$/;

/** Matches the server's MIN_PASSWORD_LENGTH (lib/account/add-member). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The short name to offer for `name`: the initials of its words,
 * upper-cased, at most four ("Taamul Connect" → "TC"). A one-word name
 * gives its first two characters ("Taamul" → "TA") so two single-word
 * workspaces are less likely to share a tile. Only ASCII letters and
 * digits are kept, because that is all a short name may hold; a name
 * with none of them suggests nothing.
 */
export function suggestShortName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '';
  const letters =
    words.length === 1
      ? words[0].slice(0, 2)
      : words.map((w) => w.charAt(0)).join('');
  return letters.slice(0, 4).toUpperCase();
}

export type WorkspaceNameError = 'nameRequired' | 'nameTooLong';
export type ShortNameError = 'shortNameInvalid';

/** The name rule of create_workspace(), or null when it passes. */
export function workspaceNameError(name: string): WorkspaceNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return 'nameRequired';
  if (trimmed.length > MAX_WORKSPACE_NAME) return 'nameTooLong';
  return null;
}

/** The short-name rule of create_workspace(), or null when it passes. */
export function shortNameError(shortName: string): ShortNameError | null {
  return SHORT_NAME_PATTERN.test(shortName.trim()) ? null : 'shortNameInvalid';
}

/** One row of the dialog's "Invite people" list. */
export interface InviteRow {
  /** Local key for React; never sent. */
  id: string;
  email: string;
  role: AddableRole;
  /** Read only for `bank_guest`. */
  bankCode: string;
}

export type InviteRowError = 'email' | 'duplicate' | 'bankCode';

export interface InviteValidation {
  ok: boolean;
  /** By row id. A blank row has no entry: it is skipped, not wrong. */
  rowErrors: Record<string, InviteRowError>;
  /** More than MAX_INVITES filled rows. */
  tooMany: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A row the person left empty: not sent, and not an error. */
function isBlank(row: InviteRow): boolean {
  return !row.email.trim();
}

/**
 * Check the invite rows before anything is sent. Blank rows are
 * ignored (the list starts with one). Each filled row needs a valid
 * email, used once across the list (case-insensitively: the second
 * copy is the one flagged), and a guest row needs its bank code.
 */
export function validateInviteRows(
  rows: readonly InviteRow[]
): InviteValidation {
  const rowErrors: Record<string, InviteRowError> = {};
  const seen = new Set<string>();
  let filled = 0;
  for (const row of rows) {
    if (isBlank(row)) continue;
    filled += 1;
    const email = normaliseEmail(row.email);
    if (!EMAIL_PATTERN.test(email)) {
      rowErrors[row.id] = 'email';
    } else if (seen.has(email)) {
      rowErrors[row.id] = 'duplicate';
    } else if (row.role === 'bank_guest' && !row.bankCode.trim()) {
      rowErrors[row.id] = 'bankCode';
    }
    seen.add(email);
  }
  const tooMany = filled > MAX_INVITES;
  return {
    ok: !tooMany && Object.keys(rowErrors).length === 0,
    rowErrors,
    tooMany,
  };
}

/** One invite as POST /api/workspaces takes it. */
export interface InvitePayload {
  email: string;
  role: AddableRole;
  bankCode?: string;
}

/**
 * The rows as POST /api/workspaces takes them: blank rows dropped,
 * emails trimmed and lower-cased, and a bank code only on a guest (the
 * server refuses one on a staff role).
 */
export function inviteRowsToPayload(
  rows: readonly InviteRow[]
): InvitePayload[] {
  return rows.flatMap((row) => {
    if (isBlank(row)) return [];
    const invite: InvitePayload = {
      email: normaliseEmail(row.email),
      role: row.role,
    };
    if (row.role === 'bank_guest') invite.bankCode = row.bankCode.trim();
    return [invite];
  });
}

/** The first message of an add that failed only because the email has
 *  no login yet (`createLogin` in lib/account/add-member). */
const NO_LOGIN_PREFIX = 'no login uses this email yet';

/**
 * Did adding a person fail because their email has no login? Then a
 * password (and optionally a name) creates one. The API answers this
 * as a 400 with a sentence and no code, so the sentence is the signal;
 * form.test.ts runs `addOrCreateMember` to keep the two in step.
 */
export function isNoLoginError(error: unknown): boolean {
  return (
    typeof error === 'string' &&
    error.trim().toLowerCase().startsWith(NO_LOGIN_PREFIX)
  );
}

/** What the dialog's "WhatsApp number" select may say. */
export const NUMBER_CHOICES = ['meta', 'whapi', 'skip'] as const;
export type NumberChoice = (typeof NUMBER_CHOICES)[number];

/** Where to land in the new workspace once it exists. */
export function afterCreatePath(choice: NumberChoice): string {
  return choice === 'skip' ? '/dashboard' : '/settings?tab=whatsapp';
}

/**
 * Should the sidebar carry the workspace rail? Only when it has
 * something to offer: another workspace to switch to, or the "+" tile.
 */
export function showWorkspaceRail(
  workspaceCount: number,
  canCreate: boolean
): boolean {
  return workspaceCount > 1 || canCreate;
}

/** One row of `chat_workspace_badges()` (migration 087). */
export interface WorkspaceBadgeRow {
  accountId: string;
  unread: number;
  mentions: number;
}

function count(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

/**
 * Narrow `chat_workspace_badges()` rows. Anything that is not a list —
 * an error body, a database without 087 — reads as no badges, and a
 * row without an account id is dropped.
 */
export function parseWorkspaceBadges(rows: unknown): WorkspaceBadgeRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw: unknown) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    if (typeof row.account_id !== 'string' || !row.account_id) return [];
    return [
      {
        accountId: row.account_id,
        unread: count(row.unread),
        mentions: count(row.mentions),
      },
    ];
  });
}

export type RailBadge =
  { kind: 'mentions'; count: number } | { kind: 'unread'; count: number };

/**
 * The badge on a workspace's tile: mentions win (a counted badge),
 * else unread messages (a dot), else none.
 */
export function badgeFor(
  accountId: string,
  badges: readonly WorkspaceBadgeRow[]
): RailBadge | null {
  const row = badges.find((b) => b.accountId === accountId);
  if (!row) return null;
  if (row.mentions > 0) return { kind: 'mentions', count: row.mentions };
  if (row.unread > 0) return { kind: 'unread', count: row.unread };
  return null;
}

/** A readable, typo-resistant password the admin can hand over as-is. */
export function suggestPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}
