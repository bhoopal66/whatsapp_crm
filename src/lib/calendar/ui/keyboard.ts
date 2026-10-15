import type { ViewKey } from './url-state';

export type KeyAction =
  | { type: 'today' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'view'; view: ViewKey }
  | { type: 'create' }
  | { type: 'focusSearch' }
  | { type: 'clearSearch' };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The keystroke landed in an input, textarea, select or contenteditable. */
  inEditable: boolean;
}

const VIEW_KEYS: Record<string, ViewKey> = {
  d: 'day',
  w: 'week',
  m: 'month',
  y: 'year',
  a: 'agenda',
};

/** The calendar's shortcuts; null leaves the key to the browser. */
export function keyAction(e: KeyInput): KeyAction | null {
  if (e.inEditable || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'ArrowLeft') return { type: 'prev' };
  if (e.key === 'ArrowRight') return { type: 'next' };
  if (e.key === 'Escape') return { type: 'clearSearch' };
  if (e.key === '/') return { type: 'focusSearch' };
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (k === 't') return { type: 'today' };
  if (k === 'j') return { type: 'prev' };
  if (k === 'k') return { type: 'next' };
  if (k === 'n') return { type: 'create' };
  if (k && VIEW_KEYS[k]) return { type: 'view', view: VIEW_KEYS[k] };
  return null;
}

/** Whether a key event's target is somewhere the person is typing. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
