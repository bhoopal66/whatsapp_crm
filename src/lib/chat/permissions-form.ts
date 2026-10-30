/**
 * Pure helpers behind Settings → Team chat's permission, message-window
 * and sensitive-data cards (migrations 157–158). The RPCs re-check
 * everything; these keep the form honest and word the confirmation.
 */

import {
  CHAT_CAPABILITIES,
  CHAT_ROLE_CLASSES,
  isDeniable,
  matrixFromRows,
  type DeniedPair,
  type PermissionMatrix,
} from './permissions';

/** 157's CHECK: a window is 1..10080 minutes (7 days), or NULL = no limit. */
export const WINDOW_MIN_MINUTES = 1;
export const WINDOW_MAX_MINUTES = 10080;

/** Quick choices offered next to the minutes field: 15 min, 1 h, 24 h, 7 days. */
export const WINDOW_PRESETS = [15, 60, 1440, 10080] as const;

export type WindowInput = { ok: true; minutes: number | null } | { ok: false };

/**
 * The minutes field's text → a window. Blank means no limit; otherwise
 * a whole number of minutes within 1..10080. Anything else (a decimal,
 * a sign, letters, out of range) is invalid rather than rounded, so the
 * saved value is always the one on screen.
 */
export function parseWindowMinutes(text: string): WindowInput {
  const s = text.trim();
  if (s === '') return { ok: true, minutes: null };
  if (!/^\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  if (n < WINDOW_MIN_MINUTES || n > WINDOW_MAX_MINUTES) return { ok: false };
  return { ok: true, minutes: n };
}

/** A saved window → the field's text (blank = no limit). */
export const windowText = (minutes: number | null): string =>
  minutes === null ? '' : String(minutes);

/** The cells that differ between the saved matrix and the draft. */
export interface MatrixChanges {
  /** Pairs the draft allows that the saved matrix denies. */
  allowed: DeniedPair[];
  /** Pairs the draft denies that the saved matrix allows. */
  denied: DeniedPair[];
}

/**
 * What saving `draft` over `saved` would change, in class and
 * capability order. A guest cell 157 cannot restrict is never counted:
 * the save never sends it, so it changes nothing.
 */
export function matrixChanges(
  saved: PermissionMatrix,
  draft: PermissionMatrix
): MatrixChanges {
  const allowed: DeniedPair[] = [];
  const denied: DeniedPair[] = [];
  for (const rc of CHAT_ROLE_CLASSES) {
    for (const cap of CHAT_CAPABILITIES) {
      if (!isDeniable(rc, cap)) continue;
      const was = saved[rc][cap] !== false;
      const now = draft[rc][cap] !== false;
      if (was === now) continue;
      (now ? allowed : denied).push({ role_class: rc, capability: cap });
    }
  }
  return { allowed, denied };
}

export const hasMatrixChanges = (c: MatrixChanges): boolean =>
  c.allowed.length + c.denied.length > 0;

/** A denied set (e.g. RECOMMENDED_DENIED) → a matrix. */
export const matrixFromDenied = (
  pairs: readonly DeniedPair[]
): PermissionMatrix => matrixFromRows(pairs);
