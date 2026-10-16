// WhatsApp groups, provider-blind.
//
// Routes hand this module a resolved `WhatsAppChannel` (from
// `channels.ts`, token already decrypted) and never touch the gateway
// client themselves. Groups are a Whapi feature here: the Meta number's
// groups are deal rooms (`meta-groups.ts`), a different lifecycle, so a
// Meta channel is refused with `GroupsUnsupportedError`.
//
// The anti-ban behaviour lives here as pure helpers so it is tested and
// cannot be skipped by a route: participants are added in small batches
// with a pause between calls and a cap per operation, phone input is
// normalised to a wa_id before anything reaches the gateway, and every
// failure is worded through `describeGroupFailure`.

import type { WhatsAppChannel } from './channels';
import { isValidE164, normalizePhone } from './phone-utils';
import * as whapi from './whapi-api';
import { WhapiError } from './whapi-api';

export type {
  WhapiGroup as Group,
  WhapiGroupParticipant as GroupParticipant,
  WhapiGroupPolicy as GroupPolicy,
  WhapiGroupRole as GroupRole,
  WhapiGroupSetting as GroupSetting,
  WhapiGroupSettings as GroupSettings,
  WhapiIdentity as GroupIdentity,
  WhapiJoinRequest as GroupJoinRequest,
  WhapiGroupPreview as GroupPreview,
  WhapiGroupIcon as GroupIcon,
} from './whapi-api';
export {
  WHAPI_GROUP_SETTINGS as GROUP_SETTINGS,
  groupInviteLink,
  isWhapiGroupId as isGroupId,
} from './whapi-api';

/** The channel is not a Whapi number; groups are Whapi-only. */
export class GroupsUnsupportedError extends Error {
  constructor(provider: string) {
    super(`WhatsApp groups need a Whapi number; this one is ${provider}.`);
    this.name = 'GroupsUnsupportedError';
  }
}

function whapiToken(channel: WhatsAppChannel): string {
  if (channel.provider !== 'whapi') {
    throw new GroupsUnsupportedError(channel.provider);
  }
  return channel.accessToken;
}

// ------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------

/** WhatsApp's limit on a group's name. */
export const GROUP_NAME_MAX = 100;

/**
 * Phone input (`+971 50 123 4567`, `00971501234567`, a chat id) → the
 * wa_id digits Whapi wants, or null when it can't be a WhatsApp number.
 */
export function toParticipantWaId(input: string): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  if (value.includes('@')) {
    const [user, domain] = value.split('@');
    if (domain !== 's.whatsapp.net' && domain !== 'c.us') return null;
    return /^[1-9]\d{6,14}$/.test(user) ? user : null;
  }
  let digits = normalizePhone(value);
  if (digits.startsWith('00')) digits = digits.slice(2);
  return isValidE164(digits) ? digits : null;
}

/** Normalise a list, dropping duplicates; invalid inputs are returned apart. */
export function normaliseParticipants(inputs: string[]): {
  waIds: string[];
  invalid: string[];
} {
  const waIds: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const waId = toParticipantWaId(input);
    if (!waId) {
      invalid.push(input);
    } else if (!seen.has(waId)) {
      seen.add(waId);
      waIds.push(waId);
    }
  }
  return { waIds, invalid };
}

// GROUP_ADD_POLICY lives in the import-free limits module: the members tab
// reads it in the browser, and this file reaches the gateway client.
import { GROUP_ADD_POLICY } from '@/lib/groups/limits';
export { GROUP_ADD_POLICY };

/**
 * How long a paced operation may keep starting calls, from the start of
 * the request. The routes run under `maxDuration = 60`; pauses and slow
 * gateway calls past that get the function killed mid-loop, with nothing
 * reported. Whatever has not started by the deadline is returned as not
 * attempted with `time_budget`, leaving room to save and answer.
 */
export const GROUP_TIME_BUDGET_MS = 45_000;

/** The deadline (epoch ms) for a request that started at `startedAt`. */
export function groupDeadline(startedAt: number = Date.now()): number {
  return startedAt + GROUP_TIME_BUDGET_MS;
}

/** A deadline plus the clock to read it by (injected in tests). */
export interface TimeBudget {
  deadline?: number;
  now?: () => number;
}

/** True while `waitMs` more still ends before the deadline (or there is none). */
export function withinBudget(budget: TimeBudget, waitMs = 0): boolean {
  if (budget.deadline === undefined) return true;
  return (budget.now ?? Date.now)() + waitMs < budget.deadline;
}

/** Longest a single paced gateway call may take. */
export const GROUP_CALL_TIMEOUT_MS = 15_000;
/**
 * Slack past the budget a call that starts just inside it may use. The
 * routes' `maxDuration` is 60 s and the budget 45 s, so the call may end
 * by 55 s, leaving 5 s to save and answer.
 */
const GROUP_CALL_SLACK_MS = 10_000;

/**
 * The timeout for one paced Whapi call: the budget left plus the slack,
 * capped at `GROUP_CALL_TIMEOUT_MS`, so a call that starts before the
 * deadline still ends before `maxDuration` (the default 30 s timeout
 * could not). No deadline (tests, other callers) keeps the gateway default.
 */
export function callTimeoutMs(budget: TimeBudget): number | undefined {
  if (budget.deadline === undefined) return undefined;
  const left = budget.deadline - (budget.now ?? Date.now)();
  return Math.max(
    1_000,
    Math.min(GROUP_CALL_TIMEOUT_MS, left + GROUP_CALL_SLACK_MS)
  );
}

export interface BatchPlan {
  batches: string[][];
  /** Past `maxPerOperation`: not added in this operation. */
  overflow: string[];
}

export function planParticipantBatches(
  waIds: string[],
  opts: { batchSize?: number; maxPerOperation?: number } = {}
): BatchPlan {
  const batchSize = Math.max(1, opts.batchSize ?? GROUP_ADD_POLICY.batchSize);
  const max = Math.max(
    0,
    opts.maxPerOperation ?? GROUP_ADD_POLICY.maxPerOperation
  );
  const take = waIds.slice(0, max);
  const batches: string[][] = [];
  for (let i = 0; i < take.length; i += batchSize) {
    batches.push(take.slice(i, i + batchSize));
  }
  return { batches, overflow: waIds.slice(max) };
}

/** The role our own number holds, from a group's participant list. */
export function ourRoleIn(
  group: { participants: whapi.WhapiGroupParticipant[] },
  ourWaId: string | null
): whapi.WhapiGroupRole | null {
  if (!ourWaId) return null;
  const me = group.participants.find((p) => p.waId === ourWaId);
  return me ? me.role : null;
}

export type GroupFailureKey =
  | 'not_whapi'
  | 'not_admin'
  | 'group_not_found'
  | 'already_member'
  | 'rate_limited'
  | 'channel_disconnected'
  | 'billing'
  | 'invalid_request'
  | 'gateway_unavailable'
  | 'time_budget'
  | 'unknown';

/**
 * A failed group call → an i18n key. Read only after a *group* call:
 * there a 403 means our number is not an admin and a 404 that the
 * group is unknown to it (a wrong token is also a 404, which Whapi
 * cannot distinguish; the health monitor catches that case).
 */
export function describeGroupFailure(err: unknown): GroupFailureKey {
  if (err instanceof GroupsUnsupportedError) return 'not_whapi';
  if (!(err instanceof WhapiError)) return 'unknown';
  if (err.isNotGroupAdmin) return 'not_admin';
  if (err.isGroupNotFound) return 'group_not_found';
  if (err.isAlreadyParticipant) return 'already_member';
  if (err.isRateLimited) return 'rate_limited';
  if (err.isBillingError) return 'billing';
  if (err.status === 401) return 'channel_disconnected';
  if (err.status === 400) return 'invalid_request';
  if (err.status >= 500) return 'gateway_unavailable';
  return 'unknown';
}

// ------------------------------------------------------------
// Operations
// ------------------------------------------------------------

export interface CreateGroupInput {
  channel: WhatsAppChannel;
  name: string;
  /** Phone numbers or wa_ids; normalised here. */
  participants: string[];
}

export interface AddOutcome {
  added: whapi.WhapiIdentity[];
  /** Refused by WhatsApp (anti-spam/privacy): offer the invite link. */
  refused: whapi.WhapiIdentity[];
  /** Not sent: past the cap, or after a call failed. */
  notAttempted: string[];
  invalid: string[];
  /** The failure that stopped the operation, if one did. */
  error: GroupFailureKey | null;
}

export interface CreateGroupOutcome extends AddOutcome {
  group: whapi.WhapiGroup;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Create a group with its first members. WhatsApp needs at least one
 * participant at creation; the rest go in through paced batches, so a
 * large opening list does not land as one burst.
 */
export async function createGroup(
  input: CreateGroupInput &
    TimeBudget & {
      pauseMs?: number;
      sleep?: (ms: number) => Promise<void>;
    }
): Promise<CreateGroupOutcome> {
  const token = whapiToken(input.channel);
  const name = input.name.trim();
  if (!name || name.length > GROUP_NAME_MAX) {
    throw new WhapiError(
      `Group name must be 1–${GROUP_NAME_MAX} characters.`,
      400
    );
  }
  const { waIds, invalid } = normaliseParticipants(input.participants);
  const plan = planParticipantBatches(waIds);
  const [first, ...rest] = plan.batches;
  if (!first) {
    throw new WhapiError('A group needs at least one valid participant.', 400);
  }
  const created = await whapi.createGroup({
    token,
    subject: name,
    participants: first,
    timeoutMs: callTimeoutMs(input),
  });
  const more = await addBatches({
    token,
    groupId: created.group.id,
    batches: rest,
    pauseMs: input.pauseMs,
    sleep: input.sleep,
    deadline: input.deadline,
    now: input.now,
  });
  return {
    group: created.group,
    added: [...created.processed, ...more.added],
    refused: [...created.failed, ...more.refused],
    notAttempted: [...more.notAttempted, ...plan.overflow],
    invalid,
    error: more.error,
  };
}

async function addBatches(
  args: TimeBudget & {
    token: string;
    groupId: string;
    batches: string[][];
    pauseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<Omit<AddOutcome, 'invalid'>> {
  const pauseMs = args.pauseMs ?? GROUP_ADD_POLICY.pauseMs;
  const sleep = args.sleep ?? sleepFor;
  const out: Omit<AddOutcome, 'invalid'> = {
    added: [],
    refused: [],
    notAttempted: [],
    error: null,
  };
  for (let i = 0; i < args.batches.length; i++) {
    const wait = i > 0 ? pauseMs : 0;
    // Checked before the pause too: sleeping past the deadline only to
    // stop afterwards spends the time the caller needs to answer.
    if (!withinBudget(args, wait)) {
      out.error = 'time_budget';
      out.notAttempted.push(...args.batches.slice(i).flat());
      break;
    }
    if (wait > 0) await sleep(wait);
    try {
      const res = await whapi.addGroupParticipants({
        token: args.token,
        groupId: args.groupId,
        participants: args.batches[i],
        timeoutMs: callTimeoutMs(args),
      });
      out.added.push(...res.processed);
      out.refused.push(...res.failed);
    } catch (err) {
      // Stop: a failure here (not admin, rate limit, number down) will
      // repeat on every later batch, and pressing on is what WhatsApp
      // reads as spam.
      out.error = describeGroupFailure(err);
      out.notAttempted.push(...args.batches.slice(i).flat());
      break;
    }
  }
  return out;
}

/**
 * Add people to an existing group, paced (`GROUP_ADD_POLICY`). Never
 * throws for a gateway failure mid-way: it reports who was added, who
 * WhatsApp refused, and who was never tried.
 */
export async function addParticipants(
  args: TimeBudget & {
    channel: WhatsAppChannel;
    groupId: string;
    participants: string[];
    pauseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<AddOutcome> {
  const token = whapiToken(args.channel);
  const { waIds, invalid } = normaliseParticipants(args.participants);
  const plan = planParticipantBatches(waIds);
  const res = await addBatches({
    token,
    groupId: args.groupId,
    batches: plan.batches,
    pauseMs: args.pauseMs,
    sleep: args.sleep,
    deadline: args.deadline,
    now: args.now,
  });
  return {
    ...res,
    notAttempted: [...res.notAttempted, ...plan.overflow],
    invalid,
  };
}

type GroupRef = { channel: WhatsAppChannel; groupId: string };

export function listGroups(args: {
  channel: WhatsAppChannel;
  maxGroups?: number;
}) {
  return whapi.listAllGroups({
    token: whapiToken(args.channel),
    maxGroups: args.maxGroups,
  });
}

export function getGroup(args: GroupRef & { resync?: boolean }) {
  return whapi.getGroup({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    resync: args.resync,
  });
}

export function updateGroupInfo(
  args: GroupRef & { name?: string; description?: string }
) {
  const name = args.name?.trim();
  if (name !== undefined && (!name || name.length > GROUP_NAME_MAX)) {
    throw new WhapiError(
      `Group name must be 1–${GROUP_NAME_MAX} characters.`,
      400
    );
  }
  return whapi.updateGroupInfo({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    subject: name,
    description: args.description,
  });
}

export function updateGroupSetting(
  args: GroupRef & {
    setting: whapi.WhapiGroupSetting;
    policy: whapi.WhapiGroupPolicy;
  }
) {
  return whapi.updateGroupSetting({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    setting: args.setting,
    policy: args.policy,
  });
}

export function leaveGroup(args: GroupRef) {
  return whapi.leaveGroup({
    token: whapiToken(args.channel),
    groupId: args.groupId,
  });
}

/** The current invite link (admin only). */
export async function getInviteLink(args: GroupRef) {
  const code = await whapi.getGroupInviteCode({
    token: whapiToken(args.channel),
    groupId: args.groupId,
  });
  return { code, link: whapi.groupInviteLink(code) };
}

/** Revoke the link and return the new one. */
export async function resetInviteLink(args: GroupRef) {
  const token = whapiToken(args.channel);
  await whapi.revokeGroupInvite({ token, groupId: args.groupId });
  const code = await whapi.getGroupInviteCode({ token, groupId: args.groupId });
  return { code, link: whapi.groupInviteLink(code) };
}

export function sendInviteLink(
  args: TimeBudget & {
    channel: WhatsAppChannel;
    inviteCode: string;
    to: string;
    body?: string;
  }
) {
  return whapi.sendGroupInvite({
    token: whapiToken(args.channel),
    inviteCode: args.inviteCode,
    to: args.to,
    body: args.body,
    timeoutMs: callTimeoutMs(args),
  });
}

export function previewInvite(args: {
  channel: WhatsAppChannel;
  inviteCode: string;
}) {
  return whapi.getGroupByInviteCode({
    token: whapiToken(args.channel),
    inviteCode: args.inviteCode,
  });
}

export function joinByInvite(args: {
  channel: WhatsAppChannel;
  inviteCode: string;
}) {
  return whapi.acceptGroupInvite({
    token: whapiToken(args.channel),
    inviteCode: args.inviteCode,
  });
}

function participantList(inputs: string[]): string[] {
  const { waIds } = normaliseParticipants(inputs);
  if (waIds.length === 0) {
    throw new WhapiError('No valid WhatsApp numbers given.', 400);
  }
  return waIds;
}

export function removeParticipants(
  args: GroupRef & { participants: string[] }
) {
  return whapi.removeGroupParticipants({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

export function promoteAdmins(args: GroupRef & { participants: string[] }) {
  return whapi.promoteGroupAdmins({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

export function demoteAdmins(args: GroupRef & { participants: string[] }) {
  return whapi.demoteGroupAdmins({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

export function getIcon(args: GroupRef) {
  return whapi.getGroupIcon({
    token: whapiToken(args.channel),
    groupId: args.groupId,
  });
}

export function setIcon(args: GroupRef & { media: string; mimeType?: string }) {
  return whapi.setGroupIcon({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    media: args.media,
    mimeType: args.mimeType,
  });
}

export function deleteIcon(args: GroupRef) {
  return whapi.deleteGroupIcon({
    token: whapiToken(args.channel),
    groupId: args.groupId,
  });
}

export function listJoinRequests(args: GroupRef) {
  return whapi.listGroupJoinRequests({
    token: whapiToken(args.channel),
    groupId: args.groupId,
  });
}

export function approveJoinRequest(args: GroupRef & { applicant: string }) {
  return whapi.approveGroupJoinRequest({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    applicant: args.applicant,
  });
}

export function rejectJoinRequest(args: GroupRef & { applicant: string }) {
  return whapi.rejectGroupJoinRequest({
    token: whapiToken(args.channel),
    groupId: args.groupId,
    applicant: args.applicant,
  });
}

function groupRecipient(groupId: string): string {
  if (!whapi.isWhapiGroupId(groupId)) {
    throw new WhapiError(`Not a WhatsApp group id: ${groupId}`, 400);
  }
  return groupId;
}

/** Text into a group (`to` = the `…@g.us` id, passed through untouched). */
export function sendGroupText(
  args: GroupRef & { text: string; quotedMessageId?: string | null }
) {
  return whapi.sendTextMessage({
    token: whapiToken(args.channel),
    to: groupRecipient(args.groupId),
    text: args.text,
    quotedMessageId: args.quotedMessageId,
  });
}

export function sendGroupMedia(
  args: GroupRef & {
    kind: whapi.MediaKind;
    link: string;
    caption?: string;
    filename?: string;
    mimeType?: string;
  }
) {
  return whapi.sendMediaMessage({
    token: whapiToken(args.channel),
    to: groupRecipient(args.groupId),
    kind: args.kind,
    link: args.link,
    caption: args.caption,
    filename: args.filename,
    mimeType: args.mimeType,
  });
}
