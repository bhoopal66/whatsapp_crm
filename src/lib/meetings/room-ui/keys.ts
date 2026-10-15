// Keyboard shortcuts in the room, and Enter in the chat box.

export type RoomShortcut =
  'mic' | 'camera' | 'share' | 'hand' | 'chat' | 'people' | 'closePanel';

const BY_KEY: Record<string, RoomShortcut> = {
  m: 'mic',
  v: 'camera',
  s: 'share',
  h: 'hand',
  c: 'chat',
  p: 'people',
  escape: 'closePanel',
};

/** The letter shown in tooltips for each shortcut. */
export const SHORTCUT_KEYS: Record<
  Exclude<RoomShortcut, 'closePanel'>,
  string
> = {
  mic: 'M',
  camera: 'V',
  share: 'S',
  hand: 'H',
  chat: 'C',
  people: 'P',
};

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** Typing in a field: shortcuts stay out of the way. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function shortcutFor(
  e: KeyLike,
  target: TargetLike | null | undefined
): RoomShortcut | null {
  if (e.defaultPrevented || e.repeat || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(target)) return null;
  return BY_KEY[e.key.toLowerCase()] ?? null;
}

/** Enter sends, Shift+Enter is a newline; never mid-IME (Korean). */
export function chatKeyAction(e: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}): 'send' | null {
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return null;
  return 'send';
}

/** Side panel width while dragging its edge. */
export function clampPanelWidth(px: number, min = 280, max = 520): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}
