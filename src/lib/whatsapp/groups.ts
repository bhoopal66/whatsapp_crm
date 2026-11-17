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
import * as openwa from './openwa-groups';
import {
  OpenWAGroupUnsupportedError,
  type OpenWAGroupCreds,
} from './openwa-groups';
import * as openwaApi from './openwa-api';
import { OpenWAError } from './openwa-api';

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

/** The channel cannot host groups: Meta (deal rooms) or a personal number. */
export class GroupsUnsupportedError extends Error {
  constructor(provider: string) {
    super(
      `WhatsApp groups need a Whapi or company OpenWA number; this one is ${provider}.`
    );
    this.name = 'GroupsUnsupportedError';
  }
}

/** The gateway cannot create groups (OpenWA answers 501). */
export class GroupCreateUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupCreateUnsupportedError';
  }
}

export type GroupGateway =
  | { kind: 'whapi'; token: string }
  | { kind: 'openwa'; creds: OpenWAGroupCreds };

/** Which group gateway serves this number; refuses Meta and personal numbers. */
export function gatewayFor(channel: WhatsAppChannel): GroupGateway {
  const provider = channel.provider;
  switch (provider) {
    case 'whapi':
      return { kind: 'whapi', token: channel.accessToken };
    case 'openwa':
      if (channel.isPersonal) {
        throw new GroupsUnsupportedError('a personal OpenWA number');
      }
      return {
        kind: 'openwa',
        creds: {
          sessionId: channel.phoneNumberId,
          apiKey: channel.accessToken,
        },
      };
    case 'meta':
      throw new GroupsUnsupportedError(provider);
    default: {
      const unknown: never = provider;
      throw new GroupsUnsupportedError(String(unknown));
    }
  }
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
  | 'create_unsupported'
  | 'unsupported'
  | 'unknown';

/**
 * A failed group call → an i18n key. Read only after a *group* call:
 * there a 403 means our number is not an admin and a 404 that the
 * group is unknown to it (a wrong token is also a 404, which Whapi
 * cannot distinguish; the health monitor catches that case).
 */
export function describeGroupFailure(err: unknown): GroupFailureKey {
  if (err instanceof GroupsUnsupportedError) return 'not_whapi';
  if (err instanceof GroupCreateUnsupportedError) return 'create_unsupported';
  if (err instanceof OpenWAGroupUnsupportedError) return 'unsupported';
  if (err instanceof OpenWAError) return describeOpenWAFailure(err);
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

/**
 * OpenWA's statuses after a group call. A 409 is the session not being
 * connected (on Whapi it means already a member), and a 404 on the
 * session route is the session itself missing, not the group.
 */
function describeOpenWAFailure(err: OpenWAError): GroupFailureKey {
  if (err.status === 403) return 'not_admin';
  if (err.status === 401) return 'channel_disconnected';
  if (err.status === 404) {
    return err.route === 'message' ? 'group_not_found' : 'channel_disconnected';
  }
  if (err.status === 409) return 'channel_disconnected';
  if (err.status === 429) return 'rate_limited';
  if (err.status === 400) return 'invalid_request';
  if (err.status === 501) return 'unsupported';
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

function openwaCreds(
  creds: OpenWAGroupCreds,
  timeoutMs: number | undefined
): OpenWAGroupCreds {
  return timeoutMs === undefined ? creds : { ...creds, timeoutMs };
}

/** A digits or `<digits>@lid` wa_id as the identity shape routes store. */
function openwaIdentity(waId: string): whapi.WhapiIdentity {
  const id = openwa.toOpenWAParticipantId(waId);
  return id ? openwa.fromOpenWAParticipantId(id) : { jid: waId, waId };
}

/**
 * The group as the OpenWA create answer describes it, for when the read
 * back fails: us as its creator (superadmin) and the first members as
 * sent. The gateway accepted them; Refresh corrects the list.
 */
function createdFallback(
  channel: WhatsAppChannel,
  groupId: string,
  name: string,
  first: readonly string[]
): whapi.WhapiGroup {
  const ourWaId = channel.wabaId ? normalizePhone(channel.wabaId) : '';
  const us: whapi.WhapiGroupParticipant[] = ourWaId
    ? [{ ...openwaIdentity(ourWaId), role: 'superadmin' }]
    : [];
  const participants: whapi.WhapiGroupParticipant[] = [
    ...us,
    ...first.map((waId) => ({
      ...openwaIdentity(waId),
      role: 'member' as const,
    })),
  ];
  return {
    id: groupId,
    name,
    description: null,
    participantsCount: participants.length,
    participants,
    createdAt: null,
    createdBy: us[0] ? { jid: us[0].jid, waId: us[0].waId } : null,
    iconUrl: null,
    inviteCode: null,
    settings: openwa.fromOpenWASettings({}),
    suspended: false,
    terminated: false,
  };
}

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
  const gw = gatewayFor(input.channel);
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
  let group: whapi.WhapiGroup;
  let added: whapi.WhapiIdentity[];
  let refused: whapi.WhapiIdentity[];
  if (gw.kind === 'whapi') {
    const created = await whapi.createGroup({
      token: gw.token,
      subject: name,
      participants: first,
      timeoutMs: callTimeoutMs(input),
    });
    group = created.group;
    added = created.processed;
    refused = created.failed;
  } else {
    const creds = openwaCreds(gw.creds, callTimeoutMs(input));
    let groupId: string;
    try {
      ({ groupId } = await openwa.createGroup(creds, {
        name,
        participants: first,
      }));
    } catch (err) {
      if (err instanceof OpenWAError && err.status === 501) {
        throw new GroupCreateUnsupportedError(err.message);
      }
      throw err;
    }
    // The create answer does not say who got in: read the group back.
    // The group exists on WhatsApp now, so a failed read must not fail
    // the create (no row would be saved, and a retry makes a second
    // group): fall back to what we know, and Refresh fills in the rest.
    let reread: whapi.WhapiGroup | null = null;
    try {
      reread = await openwa.getGroup(creds, groupId);
    } catch (err) {
      console.error('[groups] OpenWA read-back after create failed', err);
    }
    added = [];
    refused = [];
    if (reread) {
      group = reread;
      const present = new Set(group.participants.map((p) => p.waId));
      for (const waId of first) {
        (present.has(waId) ? added : refused).push(openwaIdentity(waId));
      }
    } else {
      group = createdFallback(input.channel, groupId, name, first);
      added = first.map(openwaIdentity);
    }
  }
  const more = await addBatches({
    gw,
    groupId: group.id,
    batches: rest,
    pauseMs: input.pauseMs,
    sleep: input.sleep,
    deadline: input.deadline,
    now: input.now,
  });
  return {
    group,
    added: [...added, ...more.added],
    refused: [...refused, ...more.refused],
    notAttempted: [...more.notAttempted, ...plan.overflow],
    invalid: [...invalid, ...more.invalid],
    error: more.error,
  };
}

async function addBatches(
  args: TimeBudget & {
    gw: GroupGateway;
    groupId: string;
    batches: string[][];
    pauseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<AddOutcome> {
  const pauseMs = args.pauseMs ?? GROUP_ADD_POLICY.pauseMs;
  const sleep = args.sleep ?? sleepFor;
  const out: AddOutcome = {
    added: [],
    refused: [],
    notAttempted: [],
    invalid: [],
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
      if (args.gw.kind === 'whapi') {
        const res = await whapi.addGroupParticipants({
          token: args.gw.token,
          groupId: args.groupId,
          participants: args.batches[i],
          timeoutMs: callTimeoutMs(args),
        });
        out.added.push(...res.processed);
        out.refused.push(...res.failed);
      } else {
        const results = await openwa.addParticipants(
          openwaCreds(args.gw.creds, callTimeoutMs(args)),
          args.groupId,
          args.batches[i]
        );
        const res = openwa.classifyAddResults(args.batches[i], results);
        out.added.push(...res.added);
        out.refused.push(...res.refused);
        out.invalid.push(...res.invalid);
      }
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
  const gw = gatewayFor(args.channel);
  const { waIds, invalid } = normaliseParticipants(args.participants);
  const plan = planParticipantBatches(waIds);
  const res = await addBatches({
    gw,
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
    invalid: [...invalid, ...res.invalid],
  };
}

type GroupRef = { channel: WhatsAppChannel; groupId: string };

/**
 * Every group the number is in. OpenWA lists ids and names only, so each
 * group is read one by one while the time budget lasts; past it, the
 * groups read so far are returned (the next Sync picks up the rest).
 */
export async function listGroups(
  args: TimeBudget & { channel: WhatsAppChannel; maxGroups?: number }
): Promise<whapi.WhapiGroup[]> {
  return (await listGroupsWithStatus(args)).groups;
}

/**
 * `listGroups`, saying whether the list is the number's whole set.
 * `complete: false` when the OpenWA walk ran out of time or a group's
 * read failed: a caller that marks unlisted groups as left (Sync) must
 * not do so from a partial list.
 */
export async function listGroupsWithStatus(
  args: TimeBudget & { channel: WhatsAppChannel; maxGroups?: number }
): Promise<{ groups: whapi.WhapiGroup[]; complete: boolean }> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'whapi') {
    return {
      groups: await whapi.listAllGroups({
        token: gw.token,
        maxGroups: args.maxGroups,
      }),
      complete: true,
    };
  }
  const budget: TimeBudget = {
    deadline: args.deadline ?? groupDeadline(args.now?.()),
    now: args.now,
  };
  const summaries = await openwa.listGroupSummaries(gw.creds);
  const wanted =
    args.maxGroups === undefined
      ? summaries
      : summaries.slice(0, args.maxGroups);
  const groups: whapi.WhapiGroup[] = [];
  // A list cut at maxGroups is not the number's whole set either.
  let complete = wanted.length === summaries.length;
  for (const summary of wanted) {
    if (!withinBudget(budget)) {
      console.warn(
        `[groups] OpenWA list stopped at the time budget: read ${groups.length} of ${wanted.length} groups`
      );
      complete = false;
      break;
    }
    try {
      groups.push(
        await openwa.getGroup(
          openwaCreds(gw.creds, callTimeoutMs(budget)),
          summary.id
        )
      );
    } catch (err) {
      // One unreadable group (a community parent, a group just left)
      // must not hide the rest; the list is then not the whole set.
      console.error('[groups] OpenWA group read failed', summary.id, err);
      complete = false;
    }
  }
  return { groups, complete };
}

export function getGroup(
  args: GroupRef & { resync?: boolean; timeoutMs?: number }
) {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.getGroup(openwaCreds(gw.creds, args.timeoutMs), args.groupId);
  }
  return whapi.getGroup({
    token: gw.token,
    groupId: args.groupId,
    resync: args.resync,
    timeoutMs: args.timeoutMs,
  });
}

export async function updateGroupInfo(
  args: GroupRef & { name?: string; description?: string }
): Promise<void> {
  const name = args.name?.trim();
  if (name !== undefined && (!name || name.length > GROUP_NAME_MAX)) {
    throw new WhapiError(
      `Group name must be 1–${GROUP_NAME_MAX} characters.`,
      400
    );
  }
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    if (name !== undefined) {
      await openwa.setSubject(gw.creds, args.groupId, name);
    }
    if (args.description !== undefined) {
      await openwa.setDescription(gw.creds, args.groupId, args.description);
    }
    return;
  }
  return whapi.updateGroupInfo({
    token: gw.token,
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
): Promise<void> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    // approve_participants throws OpenWAGroupUnsupportedError (→ unsupported).
    return openwa.updateSetting(
      gw.creds,
      args.groupId,
      args.setting,
      args.policy
    );
  }
  return whapi.updateGroupSetting({
    token: gw.token,
    groupId: args.groupId,
    setting: args.setting,
    policy: args.policy,
  });
}

export function leaveGroup(args: GroupRef & { timeoutMs?: number }) {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.leaveGroup(
      openwaCreds(gw.creds, args.timeoutMs),
      args.groupId
    );
  }
  return whapi.leaveGroup({
    token: gw.token,
    groupId: args.groupId,
    timeoutMs: args.timeoutMs,
  });
}

/** The current invite link (admin only). */
export async function getInviteLink(args: GroupRef) {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.getInviteCode(gw.creds, args.groupId);
  }
  const code = await whapi.getGroupInviteCode({
    token: gw.token,
    groupId: args.groupId,
  });
  return { code, link: whapi.groupInviteLink(code) };
}

/** Revoke the link and return the new one. */
export async function resetInviteLink(args: GroupRef) {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.revokeInviteCode(gw.creds, args.groupId);
  }
  const token = gw.token;
  await whapi.revokeGroupInvite({ token, groupId: args.groupId });
  const code = await whapi.getGroupInviteCode({ token, groupId: args.groupId });
  return { code, link: whapi.groupInviteLink(code) };
}

/**
 * The invite link 1:1. OpenWA has no invite message type, so it goes as
 * plain text: the body (if any), then the link.
 */
export function sendInviteLink(
  args: TimeBudget & {
    channel: WhatsAppChannel;
    inviteCode: string;
    to: string;
    body?: string;
  }
): Promise<{ messageId: string }> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    const link = whapi.groupInviteLink(args.inviteCode);
    const body = args.body?.trim();
    return openwaApi.sendTextMessage({
      ...openwaCreds(gw.creds, callTimeoutMs(args)),
      to: args.to,
      text: body ? `${body}\n\n${link}` : link,
    });
  }
  return whapi.sendGroupInvite({
    token: gw.token,
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
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.getJoinInfo(gw.creds, args.inviteCode);
  }
  return whapi.getGroupByInviteCode({
    token: gw.token,
    inviteCode: args.inviteCode,
  });
}

export function joinByInvite(args: {
  channel: WhatsAppChannel;
  inviteCode: string;
}): Promise<string> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.joinGroup(gw.creds, args.inviteCode);
  }
  return whapi.acceptGroupInvite({
    token: gw.token,
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

/** OpenWA participants: stored wa_ids, digits or `<digits>@lid`. */
function openwaParticipantList(inputs: string[]): string[] {
  const waIds = inputs
    .map((x) => x.trim())
    .filter((x) => openwa.toOpenWAParticipantId(x) !== null);
  if (waIds.length === 0) {
    throw new WhapiError('No valid WhatsApp numbers given.', 400);
  }
  return waIds;
}

export async function removeParticipants(
  args: GroupRef & { participants: string[] }
): Promise<whapi.ParticipantsResult> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    const results = await openwa.removeParticipants(
      gw.creds,
      args.groupId,
      openwaParticipantList(args.participants)
    );
    const out: whapi.ParticipantsResult = { processed: [], failed: [] };
    for (const r of results) {
      (r.success ? out.processed : out.failed).push(
        openwa.fromOpenWAParticipantId(r.id)
      );
    }
    return out;
  }
  return whapi.removeGroupParticipants({
    token: gw.token,
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

export async function promoteAdmins(
  args: GroupRef & { participants: string[] }
): Promise<void> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    await openwa.promoteParticipants(
      gw.creds,
      args.groupId,
      openwaParticipantList(args.participants)
    );
    return;
  }
  return whapi.promoteGroupAdmins({
    token: gw.token,
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

export async function demoteAdmins(
  args: GroupRef & { participants: string[] }
): Promise<void> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    await openwa.demoteParticipants(
      gw.creds,
      args.groupId,
      openwaParticipantList(args.participants)
    );
    return;
  }
  return whapi.demoteGroupAdmins({
    token: gw.token,
    groupId: args.groupId,
    participants: participantList(args.participants),
  });
}

/** Only WhatsApp's own CDN is fetched for an OpenWA picture URL. */
function isWhatsAppPictureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.whatsapp.net');
  } catch {
    return false;
  }
}

export async function getIcon(
  args: GroupRef & { fetchImpl?: typeof fetch }
): Promise<whapi.WhapiGroupIcon | null> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'whapi') {
    return whapi.getGroupIcon({ token: gw.token, groupId: args.groupId });
  }
  const url = await openwa.getPictureUrl(gw.creds, args.groupId);
  if (!url || !isWhatsAppPictureUrl(url)) return null;
  const res = await (args.fetchImpl ?? fetch)(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(GROUP_CALL_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? 'image/jpeg',
  };
}

export function setIcon(
  args: GroupRef & { media: string; mimeType?: string }
): Promise<void> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.setPicture(gw.creds, args.groupId, {
      base64: args.media,
      mimetype: args.mimeType ?? 'image/jpeg',
    });
  }
  return whapi.setGroupIcon({
    token: gw.token,
    groupId: args.groupId,
    media: args.media,
    mimeType: args.mimeType,
  });
}

export function deleteIcon(args: GroupRef): Promise<void> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    return openwa.deletePicture(gw.creds, args.groupId);
  }
  return whapi.deleteGroupIcon({ token: gw.token, groupId: args.groupId });
}

export async function listJoinRequests(
  args: GroupRef
): Promise<{ requests: whapi.WhapiJoinRequest[]; total: number | null }> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    const requests = await openwa.listJoinRequests(gw.creds, args.groupId);
    return { requests, total: requests.length };
  }
  return whapi.listGroupJoinRequests({
    token: gw.token,
    groupId: args.groupId,
  });
}

export async function approveJoinRequest(
  args: GroupRef & { applicant: string }
): Promise<{ ok: boolean; error: string | null }> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    await openwa.approveJoinRequest(gw.creds, args.groupId, args.applicant);
    return { ok: true, error: null };
  }
  return whapi.approveGroupJoinRequest({
    token: gw.token,
    groupId: args.groupId,
    applicant: args.applicant,
  });
}

export async function rejectJoinRequest(
  args: GroupRef & { applicant: string }
): Promise<{ ok: boolean; error: string | null }> {
  const gw = gatewayFor(args.channel);
  if (gw.kind === 'openwa') {
    await openwa.rejectJoinRequest(gw.creds, args.groupId, args.applicant);
    return { ok: true, error: null };
  }
  return whapi.rejectGroupJoinRequest({
    token: gw.token,
    groupId: args.groupId,
    applicant: args.applicant,
  });
}

function groupRecipient(gw: GroupGateway, groupId: string): string {
  const ok =
    gw.kind === 'openwa'
      ? /^[^@\s]+@g\.us$/.test(groupId)
      : whapi.isWhapiGroupId(groupId);
  if (!ok) {
    throw new WhapiError(`Not a WhatsApp group id: ${groupId}`, 400);
  }
  return groupId;
}

/** Text into a group (`to` = the `…@g.us` id, passed through untouched). */
export function sendGroupText(
  args: GroupRef & { text: string; quotedMessageId?: string | null }
): Promise<{ messageId: string }> {
  const gw = gatewayFor(args.channel);
  const to = groupRecipient(gw, args.groupId);
  if (gw.kind === 'openwa') {
    return openwaApi.sendTextMessage({
      ...gw.creds,
      to,
      text: args.text,
      quotedMessageId: args.quotedMessageId,
    });
  }
  return whapi.sendTextMessage({
    token: gw.token,
    to,
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
): Promise<{ messageId: string }> {
  const gw = gatewayFor(args.channel);
  const to = groupRecipient(gw, args.groupId);
  if (gw.kind === 'openwa') {
    return openwaApi.sendMediaMessage({
      ...gw.creds,
      to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      mimeType: args.mimeType,
    });
  }
  return whapi.sendMediaMessage({
    token: gw.token,
    to,
    kind: args.kind,
    link: args.link,
    caption: args.caption,
    filename: args.filename,
    mimeType: args.mimeType,
  });
}
