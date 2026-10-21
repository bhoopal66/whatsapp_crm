/**
 * Pure decisions behind the app-wide right-click menu
 * (`components/context-menu/app-context-menu.tsx`). The component reads
 * the DOM into a plain descriptor; everything that decides *what* the
 * menu shows lives here so it can be tested without a DOM.
 */

/** What the `contextmenu` event and its target look like. */
export interface ContextMenuEventFacts {
  /** Shift held: the user explicitly asked for the browser's own menu. */
  shift: boolean;
  /** Inside an input, textarea, select or contenteditable element. */
  editable: boolean;
  /** Inside an element marked `data-native-context-menu`. */
  nativeMarked: boolean;
  /** A more specific handler already called `preventDefault()`. */
  defaultPrevented: boolean;
}

/**
 * - `native`: leave the event alone, the browser menu opens.
 * - `elsewhere`: someone else owns this right-click (it was already
 *   prevented and is showing its own UI); do nothing.
 * - `app`: prevent the browser menu and open ours.
 */
export type ContextMenuDecision = 'native' | 'elsewhere' | 'app';

export function decideContextMenu(
  facts: ContextMenuEventFacts
): ContextMenuDecision {
  if (facts.defaultPrevented) return 'elsewhere';
  // Spell check, paste and "inspect" live in the native menu of a text
  // field; an app menu there would take them away.
  if (facts.shift || facts.editable || facts.nativeMarked) return 'native';
  return 'app';
}

export interface ResolvedLink {
  /** Absolute URL. */
  url: string;
  /** http(s) on this page's origin: open through the Next router. */
  sameOrigin: boolean;
  /** Path + query + hash, for the router when `sameOrigin`. */
  path: string;
  /** http(s): can be opened in a tab. Other schemes are copy-only. */
  openable: boolean;
}

/**
 * Resolves a raw `href`/`src` attribute against the page URL. Returns
 * null for nothing usable: empty, unparsable, or `javascript:` (never
 * run a link's script from a menu, and its "address" is not one).
 */
export function resolveLink(
  raw: string | null | undefined,
  pageUrl: string
): ResolvedLink | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    parsed = new URL(trimmed, page);
  } catch {
    return null;
  }
  if (parsed.protocol === 'javascript:') return null;
  const openable = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  return {
    url: parsed.href,
    sameOrigin: openable && parsed.origin === page.origin,
    path: parsed.pathname + parsed.search + parsed.hash,
    openable,
  };
}

/** The generic actions the menu can offer, by group. */
export type GenericAction =
  | 'link.open'
  | 'link.openNewTab'
  | 'link.copy'
  | 'image.openNewTab'
  | 'image.copy'
  | 'selection.copy'
  | 'page.back'
  | 'page.forward'
  | 'page.reload'
  | 'page.copyLink'
  | 'page.toggleMode';

export type GenericGroupId = 'link' | 'image' | 'selection' | 'page';

export interface GenericGroup {
  id: GenericGroupId;
  actions: GenericAction[];
}

export interface TargetFacts {
  /** The nearest `a[href]`, resolved. */
  link: ResolvedLink | null;
  /** The target `img`'s src, resolved. */
  image: ResolvedLink | null;
  /** `window.getSelection()` text at the moment of the right-click. */
  selectionText: string;
}

/**
 * The generic groups for a target, most specific first. The page group
 * is always last and always present, so the menu is never empty.
 */
export function genericGroups(facts: TargetFacts): GenericGroup[] {
  const groups: GenericGroup[] = [];
  if (facts.link) {
    groups.push({
      id: 'link',
      actions: facts.link.openable
        ? ['link.open', 'link.openNewTab', 'link.copy']
        : ['link.copy'],
    });
  }
  // An image without an http(s) source (data:, blob:) has no address
  // worth opening or copying.
  if (facts.image?.openable) {
    groups.push({ id: 'image', actions: ['image.openNewTab', 'image.copy'] });
  }
  if (facts.selectionText.trim()) {
    groups.push({ id: 'selection', actions: ['selection.copy'] });
  }
  groups.push({
    id: 'page',
    actions: [
      'page.back',
      'page.forward',
      'page.reload',
      'page.copyLink',
      'page.toggleMode',
    ],
  });
  return groups;
}

/**
 * Registered item lists may carry separators; drop the ones that would
 * render as a stray line (leading, trailing, doubled).
 */
export function tidySeparators<T>(
  entries: readonly T[],
  isSeparator: (entry: T) => boolean
): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (isSeparator(entry)) {
      if (out.length === 0 || isSeparator(out[out.length - 1])) continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

/**
 * Which pointer produced a `contextmenu` event. A long-press on a touch
 * screen fires one too, and some surfaces (the inbox message toolbar)
 * keep their own touch behaviour. `lastPointerType` is the type of the
 * pointerdown that preceded the event, `firesTouchEvents` Chrome's
 * `sourceCapabilities` hint; neither known means not touch, so a mouse
 * or keyboard (Shift+F10, the Menu key) gets the app menu.
 */
export function isTouchContextMenu(input: {
  lastPointerType: string | null;
  firesTouchEvents: boolean | null;
}): boolean {
  if (input.lastPointerType) return input.lastPointerType === 'touch';
  return input.firesTouchEvents === true;
}
