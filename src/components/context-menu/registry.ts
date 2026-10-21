'use client';

import { useEffect, useRef, type ComponentType, type RefObject } from 'react';

/** One action in the right-click menu. */
export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Display-only hint, e.g. "R". The menu does not bind the key. */
  shortcut?: string;
}

/** A nested list, e.g. React → the quick emojis. */
export interface ContextMenuSubmenu {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  items: ContextMenuAction[];
  disabled?: boolean;
}

export interface ContextMenuSeparatorEntry {
  type: 'separator';
}

export type ContextMenuEntry =
  ContextMenuAction | ContextMenuSubmenu | ContextMenuSeparatorEntry;

export const CONTEXT_MENU_SEPARATOR: ContextMenuSeparatorEntry = {
  type: 'separator',
};

export function isSeparator(
  entry: ContextMenuEntry
): entry is ContextMenuSeparatorEntry {
  return 'type' in entry && entry.type === 'separator';
}

export function isSubmenu(
  entry: ContextMenuEntry
): entry is ContextMenuSubmenu {
  return 'items' in entry;
}

type ItemsGetter = () => readonly ContextMenuEntry[];

// Element → getter. A WeakMap, so an unmounted element that never ran
// its cleanup still cannot leak; the global handler walks up from the
// event target and asks the first element that has one.
const registry = new WeakMap<Element, ItemsGetter>();

/**
 * Registers item actions on an element React does not render, e.g. a
 * FullCalendar event (`eventDidMount`). Returns the unregister call.
 */
export function registerContextMenuItems(
  el: Element,
  getItems: ItemsGetter
): () => void {
  registry.set(el, getItems);
  return () => {
    if (registry.get(el) === getItems) registry.delete(el);
  };
}

/**
 * Registers item actions for the element behind `ref`. The getter runs
 * at right-click time, so it can read the latest props without the
 * registration being redone on every render.
 */
export function useContextMenuItems(
  ref: RefObject<Element | null>,
  getItems: ItemsGetter
): void {
  const getterRef = useRef(getItems);
  const stableGetter = useRef<ItemsGetter>(() => getterRef.current());
  // No dependency list on purpose: re-registering after every render is a
  // WeakMap write, and it follows the element if a re-render swaps the
  // node behind `ref`. The unregister is identity-checked, so it never
  // removes another registration on the same element.
  useEffect(() => {
    getterRef.current = getItems;
    const el = ref.current;
    if (!el) return;
    return registerContextMenuItems(el, stableGetter.current);
  });
}

/**
 * The item actions of the nearest ancestor (or the target itself) that
 * registered a non-empty list. One list only: a registered row inside a
 * registered panel shows the row's actions, not both.
 */
export function findRegisteredItems(
  target: Element | null
): readonly ContextMenuEntry[] {
  for (let el = target; el; el = el.parentElement) {
    const getter = registry.get(el);
    if (!getter) continue;
    const items = getter();
    if (items.length > 0) return items;
  }
  return [];
}
