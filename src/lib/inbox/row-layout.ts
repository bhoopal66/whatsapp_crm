import type { ConversationHandler } from './handler';

/**
 * The inbox list row's third line (tags and who holds the chat), kept
 * pure so the narrow desktop column and the phone row can be tested
 * without a DOM.
 */

/** Longest sub-tag ("RAKBANK", "Emirates") the row shows whole. */
export const SUB_TAG_MAX_CHARS = 8;

/**
 * A sub-tag short enough to sit beside the main tag in a narrow row:
 * the name itself when it fits, a long multi-word name's initials
 * ("Abu Dhabi Commercial Bank" -> "ADCB"), a two-word name's first word
 * ("Emirates NBD" -> "Emirates") when that fits, else the start of the
 * name with an ellipsis. The row's tooltip always carries the full
 * "main · sub" name, so this only has to be recognisable.
 */
export function compactSubTagLabel(
  name: string,
  max: number = SUB_TAG_MAX_CHARS
): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const words = clean.split(' ').filter(Boolean);
  if (words.length >= 3) {
    const initials = words
      .map((w) => Array.from(w)[0] ?? '')
      .join('')
      .toUpperCase();
    if (initials.length <= max) return initials;
  }
  if (words.length === 2 && words[0].length <= max) return words[0];
  return `${Array.from(clean)
    .slice(0, Math.max(1, max - 1))
    .join('')}…`;
}

/**
 * What the row's assignee slot says. `assigned` names the assignee; any
 * other state reads "Unassigned" (muted, never the warning colour: the
 * word is the signal now), with the owner's name kept for the tooltip
 * because an unassigned chat often still has someone behind it.
 */
export type RowAssignee =
  | { kind: 'assigned'; name: string }
  | { kind: 'unassigned'; ownerName: string | null };

export function rowAssignee(
  handler: ConversationHandler | null,
  handlerName: string | null
): RowAssignee {
  if (handler?.kind === 'assigned' && handlerName) {
    return { kind: 'assigned', name: handlerName };
  }
  return {
    kind: 'unassigned',
    ownerName: handler && handlerName ? handlerName : null,
  };
}

/**
 * Whether an unassigned row offers its own small Assign menu.
 *
 * Only where the row already names who holds each chat (`showAssignee`:
 * a viewer whose list mixes other people's chats), only on a chat nobody
 * holds, never on someone's personal chat (only its owner takes it,
 * migration 191; the header refuses everyone else too), never on an HR
 * row (the HR panel owns assignment there), and only when the
 * `assignableMembers` list has anyone to offer.
 */
export function rowOffersAssign(input: {
  showAssignee: boolean;
  assignedAgentId: string | null | undefined;
  personalOwnerId: string | null | undefined;
  hrRow: boolean;
  assignableCount: number;
  shareOnly: boolean;
}): boolean {
  return (
    input.showAssignee &&
    !input.assignedAgentId &&
    !input.personalOwnerId &&
    !input.hrRow &&
    !input.shareOnly &&
    input.assignableCount > 0
  );
}

/**
 * Whether the row gets its third line: anything the old meta line
 * carried, or a chat tag, which no longer shares the preview's line.
 */
export function rowHasDetailLine(input: {
  hasMeta: boolean;
  hasChatTag: boolean;
}): boolean {
  return input.hasMeta || input.hasChatTag;
}
