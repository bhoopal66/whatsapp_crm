import { GO_KEYS } from './keys';

export interface ShortcutRow {
  /** Keys in the order pressed; 'mod' is Cmd or Ctrl. */
  keys: readonly string[];
  /** `Sidebar` message key naming the screen, for go-to rows. */
  labelKey?: string;
  /** `CommandBar` message key for the other rows. */
  commandKey?: string;
}

const GO_LABELS: Record<string, string> = {
  '/inbox': 'inbox',
  '/worklist': 'worklist',
  '/contacts': 'contacts',
  '/cases': 'cases',
};

/**
 * The shortcuts to list for this person: go-to rows only for screens
 * they may open, plus the always-available ones.
 */
export function listShortcuts(
  allowedHrefs: ReadonlySet<string>
): ShortcutRow[] {
  const rows: ShortcutRow[] = [
    { keys: ['mod', 'k'], commandKey: 'shortcutOpen' },
    { keys: ['?'], commandKey: 'shortcutHelp' },
  ];
  for (const [key, href] of Object.entries(GO_KEYS)) {
    if (allowedHrefs.has(href))
      rows.push({ keys: ['g', key], labelKey: GO_LABELS[href] });
  }
  return rows;
}
