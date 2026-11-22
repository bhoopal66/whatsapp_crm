/**
 * Which modifier key name to show for the command bar's shortcut: Cmd on
 * a Mac (and iPad/iPhone keyboards), Ctrl everywhere else. Pure, so it
 * is tested in the node environment.
 */
export function isApplePlatform(
  nav: { platform?: string; userAgent?: string } | null | undefined
): boolean {
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /\b(Mac|iPhone|iPad|iPod)/i.test(text);
}

/** The modifier's display name for this platform. */
export function modifierKeyName(apple: boolean): 'Cmd' | 'Ctrl' {
  return apple ? 'Cmd' : 'Ctrl';
}
