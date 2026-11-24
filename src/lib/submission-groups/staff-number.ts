/**
 * A staff member's saved WhatsApp number (`coordinator_phones`, read through
 * migration 219's `staff_saved_phone`) follows their access to a submission
 * group: giving access adds the number to the WhatsApp group, removing
 * access takes it out (read through 299's `staff_removal_phone`, so also for
 * someone deactivated or demoted since). The reverse grant (a saved number joining the group)
 * is `sg_staff_number_joined`, called from the webhook and after Add number.
 *
 * Staff adds never go through 211's sg_add_number ledger: that is the
 * group's 10-a-day budget for customer-side numbers, and a staff number is
 * not a contact, so there is no consent check either. Without a saved number
 * access works as before (the person sends through the group's number).
 */
import { forms } from './rules';
import type { SubmissionGroup } from './store';

export type StaffNumberAddStatus =
  'added' | 'already' | 'none' | 'skipped' | 'refused' | 'failed';
export type StaffNumberRemoveStatus = 'removed' | 'none' | 'skipped' | 'failed';

export interface StaffNumberOutcome<S extends string> {
  status: S;
  reason?: string;
}

type GroupSide = Pick<
  SubmissionGroup,
  'status' | 'waMode' | 'channelId' | 'waGroupId'
>;

export type StaffNumberPlan =
  | { go: true; channelId: string; waGroupId: string; phone: string }
  | { go: false; status: 'none' | 'skipped'; reason: string };

/**
 * Pure: whether a saved number can be added to / removed from the group's
 * WhatsApp side at all. Never touches the customer's number.
 */
export function planStaffNumber(
  group: GroupSide,
  savedPhone: string | null,
  customerPhone: string | null
): StaffNumberPlan {
  const phone = (savedPhone ?? '').replace(/\D/g, '');
  if (group.status !== 'ACTIVE')
    return { go: false, status: 'skipped', reason: 'not_active' };
  if (group.waMode === 'none')
    return { go: false, status: 'skipped', reason: 'no_whatsapp' };
  if (!group.channelId)
    return { go: false, status: 'skipped', reason: 'detached' };
  if (!group.waGroupId)
    return { go: false, status: 'skipped', reason: 'no_group_yet' };
  // After the group's own reasons: on a removal it is shown as a warning,
  // which a case without a WhatsApp group must not give.
  if (!phone) return { go: false, status: 'none', reason: 'no_saved_number' };
  if (samePhone(phone, customerPhone))
    return { go: false, status: 'skipped', reason: 'customer_number' };
  return {
    go: true,
    channelId: group.channelId,
    waGroupId: group.waGroupId,
    phone,
  };
}

/** True when two phones are the same number in any trunk-0 form. */
export function samePhone(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const want = new Set(forms(a).filter(Boolean));
  return forms(b.replace(/@.*$/, '')).some((f) => want.has(f));
}

export interface StaffNumberDeps {
  savedPhone(accountId: string, userId: string): Promise<string | null>;
  /** Like savedPhone, also for a person who is no longer live staff. */
  removalPhone(accountId: string, userId: string): Promise<string | null>;
  customerPhone(contactId: string): Promise<string | null>;
  /** null: the group or number is gone or disconnected. */
  getParticipants(
    channelId: string,
    waGroupId: string
  ): Promise<string[] | null>;
  addParticipant(
    channelId: string,
    waGroupId: string,
    phone: string
  ): Promise<'added' | 'refused'>;
  removeParticipant(
    channelId: string,
    waGroupId: string,
    phone: string
  ): Promise<void>;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

type LinkGroup = GroupSide &
  Pick<SubmissionGroup, 'id' | 'accountId' | 'contactId'>;

async function prepare(
  deps: StaffNumberDeps,
  group: LinkGroup,
  saved: string | null
): Promise<StaffNumberPlan> {
  const customer = group.contactId
    ? await deps.customerPhone(group.contactId)
    : null;
  return planStaffNumber(group, saved, customer);
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : 'unknown error';

/** After access is given: add the saved number unless it is already in. Never throws. */
export async function addStaffNumber(
  deps: StaffNumberDeps,
  group: LinkGroup,
  userId: string
): Promise<StaffNumberOutcome<StaffNumberAddStatus>> {
  try {
    const saved = await deps.savedPhone(group.accountId, userId);
    const plan = await prepare(deps, group, saved);
    if (!plan.go) return { status: plan.status, reason: plan.reason };
    const members = await deps.getParticipants(plan.channelId, plan.waGroupId);
    if (members === null)
      return { status: 'skipped', reason: 'number_unavailable' };
    if (members.some((m) => samePhone(plan.phone, m)))
      return { status: 'already' };
    const out = await deps.addParticipant(
      plan.channelId,
      plan.waGroupId,
      plan.phone
    );
    return out === 'added'
      ? { status: 'added' }
      : { status: 'refused', reason: 'privacy' };
  } catch (err) {
    deps.logger?.warn('staff number could not be added', {
      groupId: group.id,
      err: errText(err),
    });
    return { status: 'failed', reason: 'gateway' };
  }
}

/** After access is removed: take the saved number out if it is in. Never throws. */
export async function removeStaffNumber(
  deps: StaffNumberDeps,
  group: LinkGroup,
  userId: string
): Promise<StaffNumberOutcome<StaffNumberRemoveStatus>> {
  try {
    const saved = await deps.removalPhone(group.accountId, userId);
    const plan = await prepare(deps, group, saved);
    if (!plan.go) return { status: plan.status, reason: plan.reason };
    const members = await deps.getParticipants(plan.channelId, plan.waGroupId);
    if (members === null)
      return { status: 'skipped', reason: 'number_unavailable' };
    // `samePhone` drops the suffix, and a LID's digits are no phone.
    const hidden = members.some((m) => m.endsWith('@lid'));
    if (!members.some((m) => !m.endsWith('@lid') && samePhone(plan.phone, m)))
      return hidden
        ? { status: 'failed', reason: 'number_unconfirmed' }
        : { status: 'none', reason: 'not_in_group' };
    await deps.removeParticipant(plan.channelId, plan.waGroupId, plan.phone);
    return { status: 'removed' };
  } catch (err) {
    deps.logger?.warn('staff number could not be removed', {
      groupId: group.id,
      err: errText(err),
    });
    return { status: 'failed', reason: 'gateway' };
  }
}
