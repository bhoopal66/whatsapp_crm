/**
 * Whether reloading this tab would throw away something a person typed
 * or is in the middle of. Asked before a reload nobody pressed
 * (use-stale-build.ts).
 */

const holders = new Set<() => boolean>();

/**
 * `hasWork` answers whether work kept in memory, off the page, would die
 * with the tab (a draft parked for another chat, a call). Answers how to
 * stop asking it.
 */
export function holdUnsaved(hasWork: () => boolean): () => void {
  holders.add(hasWork);
  return () => {
    holders.delete(hasWork);
  };
}

export function unsavedInMemory(): boolean {
  return [...holders].some((hasWork) => hasWork());
}

/** The parts of a field read here, so the rule is tested without a DOM. */
export interface FieldLike {
  tagName: string;
  type?: string;
  value?: string;
  textContent?: string | null;
  readOnly?: boolean;
  disabled?: boolean;
  getAttribute(name: string): string | null;
}

/** Inputs that hold words; the rest (a checkbox, a search box) hold no work. */
const TEXT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'password',
  'date',
  'time',
  'datetime-local',
  // A picked file not sent yet.
  'file',
]);

export function fieldHasText(el: FieldLike): boolean {
  if (el.disabled || el.readOnly) return false;
  // Mirrors a widget keeps for form posts (base-ui's Select) hold a value
  // all the time. Only the element itself counts: a modal dialog marks
  // everything outside it aria-hidden, and a field behind it still holds
  // what was typed.
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' && !TEXT_TYPES.has(el.type ?? 'text')) return false;
  const text =
    tag === 'input' || tag === 'textarea' ? el.value : el.textContent;
  return (text ?? '').trim() !== '';
}

export function textOnPage(doc: {
  querySelectorAll(selector: string): Iterable<unknown>;
}): boolean {
  for (const el of doc.querySelectorAll(
    'textarea, input, [contenteditable="true"]'
  )) {
    if (fieldHasText(el as FieldLike)) return true;
  }
  return false;
}
