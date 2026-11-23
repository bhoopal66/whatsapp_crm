/**
 * Keyboard rules for the command bar and its single-key shortcuts. Pure:
 * the component feeds in a plain description of each key event.
 */

export interface KeyInfo {
  /** Chrome's autofill dispatches a keydown that has none. */
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** Ctrl+K (Cmd+K on a Mac), with no other modifier. */
export function isOpenShortcut(e: KeyInfo): boolean {
  return (
    e.key?.toLowerCase() === 'k' &&
    (e.ctrlKey || e.metaKey) &&
    !(e.ctrlKey && e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    !e.isComposing
  );
}

/** What a key event's target looks like, structurally (no DOM types). */
export interface TargetInfo {
  tagName?: string;
  isContentEditable?: boolean;
  role?: string | null;
  /**
   * The target sits inside an open menu or list (MENU_SELECTOR), where a
   * letter is type-ahead.
   */
  insideMenu?: boolean;
}

/** Where a letter key moves the selection instead of being a shortcut. */
export const MENU_SELECTOR =
  '[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[role="combobox"]';

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Typing somewhere: single-key shortcuts must stay out of the way. */
export function isTypingTarget(t: TargetInfo | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable || t.insideMenu) return true;
  if (t.tagName && TEXT_TAGS.has(t.tagName.toUpperCase())) return true;
  return (
    t.role === 'textbox' || t.role === 'combobox' || t.role === 'searchbox'
  );
}

/** How long `g` waits for its second key. */
export const CHORD_TIMEOUT_MS = 1000;

export interface ChordState {
  /** When `g` was pressed, or null. */
  pendingAt: number | null;
}

export const IDLE_CHORD: ChordState = { pendingAt: null };

export type ShortcutAction =
  { type: 'navigate'; href: string } | { type: 'help' };

/** `g` then one of these goes to the screen. */
export const GO_KEYS: Readonly<Record<string, string>> = {
  i: '/inbox',
  w: '/worklist',
  c: '/contacts',
  k: '/cases',
};

export interface ShortcutContext {
  /** Hrefs the person may open (the role-filtered nav). */
  allowedHrefs: ReadonlySet<string>;
  typing: boolean;
  /** Any dialog, including this bar, is open. */
  dialogOpen: boolean;
}

/**
 * One key event through the single-key shortcuts (`g i`, `g w`, `g c`,
 * `g k`, `?`). Returns the next chord state and what to do, if anything.
 * The caller prevents default only when `action` is set.
 */
export function stepShortcut(
  state: ChordState,
  e: KeyInfo,
  now: number,
  ctx: ShortcutContext
): { state: ChordState; action: ShortcutAction | null } {
  const none = { state: IDLE_CHORD, action: null };
  if (ctx.typing || ctx.dialogOpen || e.isComposing) return none;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return none;
  // `?` itself needs Shift on most layouts; nothing else may use it.
  if (e.key === '?') return { state: IDLE_CHORD, action: { type: 'help' } };
  if (e.shiftKey) return none;

  const key = e.key?.toLowerCase() ?? '';
  const waiting =
    state.pendingAt !== null && now - state.pendingAt <= CHORD_TIMEOUT_MS;
  if (waiting) {
    const href = GO_KEYS[key];
    if (href && ctx.allowedHrefs.has(href)) {
      return { state: IDLE_CHORD, action: { type: 'navigate', href } };
    }
  }
  // `g` (re)starts the chord, so `g g i` still works.
  return key === 'g' ? { state: { pendingAt: now }, action: null } : none;
}
