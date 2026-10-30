/**
 * The New channel dialog's rules, free of React. chat_create_channel
 * (087) decides; this only shapes the form and the call it makes.
 */
import { hasMinRole, isAccountRole, isBankGuest } from '@/lib/auth/roles';

import {
  CHANNEL_TOPIC_MAX,
  DM_MAX_OTHERS,
  channelNameProblem,
  finalChannelName,
  type NameProblem,
} from './compose';
import { addCandidates, addRules } from './membership';
import type { ChatCapability } from './permissions';
import type { Channel, ChatPerson } from './types';
import { chatErrorKey } from './view';

type ChatCapabilities = Record<ChatCapability, boolean>;

export type NewChannelType = 'team' | 'private' | 'deal_room';

export interface NewChannelForm {
  type: NewChannelType;
  name: string;
  topic: string;
  memberIds: readonly string[];
}

export interface CreateChannelInput {
  accountId: string;
  kind: 'team' | 'private';
  name: string;
  topic: string | null;
  memberIds: string[];
}

export type FormBlock = NameProblem | 'dealRoom' | 'noWorkspace';

/**
 * The New channel dialog's deal-room card. deal_room_create (088)
 * refuses anyone below agent, so a viewer sees it disabled with why; a
 * bank guest, who opens no channel of any kind, is not shown it.
 */
export function dealRoomOption(
  accountRole: string | null
): 'open' | 'agentsOnly' | 'hidden' {
  if (!isAccountRole(accountRole) || isBankGuest(accountRole)) return 'hidden';
  return hasMinRole(accountRole, 'agent') ? 'open' : 'agentsOnly';
}

/**
 * Whom a new private channel may start with. The creator becomes its
 * admin, so the members panel's rules apply: non-guests always, bank
 * guests only for a workspace owner/admin/team leader.
 */
export function privateMemberCandidates(
  people: readonly ChatPerson[],
  userId: string | null,
  accountRole: string | null
): ChatPerson[] {
  if (!userId) return [];
  const rules = addRules({
    kind: 'private',
    archived: false,
    myRole: 'admin',
    accountRole,
  });
  return addCandidates(people, [{ userId }], rules);
}

/** The createChannel call the form makes, or why it cannot be made yet. */
export function createChannelInput(
  form: NewChannelForm,
  accountId: string | null,
  channels: readonly Pick<Channel, 'kind' | 'name' | 'archivedAt'>[]
): CreateChannelInput | FormBlock {
  if (form.type === 'deal_room') return 'dealRoom';
  if (!accountId) return 'noWorkspace';
  const problem = channelNameProblem(form.name, channels);
  if (problem) return problem;
  return {
    accountId,
    kind: form.type,
    name: finalChannelName(form.name),
    topic: form.topic.trim().slice(0, CHANNEL_TOPIC_MAX) || null,
    memberIds: form.type === 'private' ? [...new Set(form.memberIds)] : [],
  };
}

/** A failed create that is the name's fault: the unique index refused it. */
export const nameTakenError = (err: unknown): boolean =>
  chatErrorKey(err) === 'duplicateName';

/**
 * The channel kinds the role permissions (157) let the caller create,
 * in the dialog's order. Empty = the sidebar hides its compose button.
 */
export function allowedChannelKinds(
  can: Readonly<
    Pick<ChatCapabilities, 'create_team_channel' | 'create_private_channel'>
  >
): ('team' | 'private')[] {
  return [
    ...(can.create_team_channel ? (['team'] as const) : []),
    ...(can.create_private_channel ? (['private'] as const) : []),
  ];
}

/**
 * How many other people the DM picker lets the caller choose: one
 * without open_group_dm (a group DM is 3+ people including the
 * caller), else the 087 maximum.
 */
export const dmSelectionMax = (
  can: Readonly<Pick<ChatCapabilities, 'open_group_dm'>>
): number => (can.open_group_dm ? DM_MAX_OTHERS : 1);
