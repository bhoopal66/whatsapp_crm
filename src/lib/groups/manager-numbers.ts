// A group's managers and their saved numbers move together: a person
// made a manager has their saved number (`staff_saved_phone`, from
// `coordinator_phones`) added to the WhatsApp group, and a manager who
// is dropped has it removed. The reverse direction (a saved number
// that joins the group becomes a manager) is a trigger in migration
// 219. This module is the pure decision; the managers route does the
// I/O. Nothing here may fail the manager write itself.

import type { GroupActionBlock } from './access';

/** Why our number can't change the group's members right now. */
export type NumberBlock = Exclude<GroupActionBlock, 'not_allowed'>;

export interface ManagerNumberChange {
  userId: string;
  name: string;
  /** Bare digits, as a participant's `wa_id`. */
  waId: string;
}

export interface ManagerNumberPlan {
  add: ManagerNumberChange[];
  remove: ManagerNumberChange[];
  /** People whose number would have changed but can't (block). */
  skipped: { name: string; reason: NumberBlock }[];
}

/** The numbers report the managers PUT answers with. */
export interface ManagerNumbersReport {
  added: string[];
  removed: string[];
  failed: { name: string; reason: string }[];
}

/** Who became a manager and who stopped being one (never the creator). */
export function diffManagers(args: {
  before: readonly string[];
  after: readonly string[];
  creatorId: string | null;
}): { added: string[]; removed: string[] } {
  const before = new Set(args.before);
  const after = new Set(args.after);
  return {
    added: [...after].filter((u) => !before.has(u)),
    removed: [...before].filter((u) => !after.has(u) && u !== args.creatorId),
  };
}

const digitsOf = (value: string | null | undefined): string =>
  (value ?? '').replace(/\D/g, '');

/**
 * Which saved numbers to add to or remove from the WhatsApp group.
 * A person with no saved number is left out (they send from the app as
 * before). Our own number is never touched; an added number already in
 * the group and a removed number not in it need nothing. A participant
 * WhatsApp shows only by its LID (`<digits>@lid`) never matches.
 */
export function planManagerNumbers(args: {
  added: readonly string[];
  removed: readonly string[];
  /** userId → saved number (any format) or null. */
  phones: ReadonlyMap<string, string | null>;
  names: ReadonlyMap<string, string>;
  /** The group's current participant `wa_id`s. */
  participants: readonly string[];
  /** Our number's digits, or null when unknown. */
  ourNumber: string | null;
  block: NumberBlock | null;
}): ManagerNumberPlan {
  const present = new Set(args.participants.filter((w) => /^\d+$/.test(w)));
  const ours = digitsOf(args.ourNumber);
  const plan: ManagerNumberPlan = { add: [], remove: [], skipped: [] };
  const consider = (userId: string, adding: boolean) => {
    const waId = digitsOf(args.phones.get(userId));
    if (!waId || waId === ours) return;
    if (present.has(waId) === adding) return;
    const name = args.names.get(userId) ?? '';
    if (args.block) {
      plan.skipped.push({ name, reason: args.block });
      return;
    }
    (adding ? plan.add : plan.remove).push({ userId, name, waId });
  };
  for (const u of args.added) consider(u, true);
  for (const u of args.removed) consider(u, false);
  return plan;
}
