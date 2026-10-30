/**
 * Which composer controls the viewer meets, from the role permissions
 * (157), the channel's posting rules (157) and the sensitive-data guard
 * (158). UX only: chat_post_message re-checks every one of these, so a
 * stale answer here costs a refusal, never a leak.
 */
import type { ChatErrorKey } from './errors';
import type {
  ChannelRule,
  ChatCapability,
  SensitiveGuard,
} from './permissions';
import type { ChannelKind, ChannelRole } from './types';

type Can = Readonly<Record<ChatCapability, boolean>>;

/**
 * chat_is_channel_admin (157): a live workspace owner/admin, or the
 * channel's own admin; a bank guest never counts.
 */
export function countsAsChannelAdmin(i: {
  workspaceAdmin: boolean;
  role: ChannelRole | null | undefined;
  bankGuest: boolean;
}): boolean {
  return !i.bankGuest && (i.workspaceAdmin || i.role === 'admin');
}

/** The buttons beside the input the viewer's role may use. */
export function composerControls(can: Can): {
  attach: boolean;
  voice: boolean;
} {
  return { attach: can.upload_files, voice: can.send_voice };
}

/**
 * chat_post_message's @channel / @here test,
 * `(?:^|[^[:alnum:]_])@(channel|here)(?![[:alnum:]_])`, case-insensitive.
 */
const EVERYONE = /(?<![\p{L}\p{N}_])@(channel|here)(?![\p{L}\p{N}_])/iu;
export const mentionsEveryone = (body: string): boolean => EVERYONE.test(body);

/**
 * May the viewer notify everyone here: the role permission (any channel
 * kind), and the channel's rule when it is admins-only.
 */
export function mayNotifyEveryone(i: {
  can: Can;
  rule: ChannelRule;
  channelAdmin: boolean;
}): boolean {
  return i.can.mention_everyone && (i.rule === 'everyone' || i.channelAdmin);
}

/** The popover offers @channel / @here (team and private channels only). */
export const offersEveryone = (i: {
  broadcastKind: boolean;
  can: Can;
  rule: ChannelRule;
  channelAdmin: boolean;
}): boolean => i.broadcastKind && mayNotifyEveryone(i);

/** The refusal a body would earn for notifying everyone, else null. */
export function everyoneRefusal(
  body: string,
  i: { can: Can; rule: ChannelRule; channelAdmin: boolean }
): ChatErrorKey | null {
  return mentionsEveryone(body) && !mayNotifyEveryone(i)
    ? 'mentionEveryoneRestricted'
    : null;
}

export type PostingBlock = 'postingRestricted' | 'repliesRestricted';

/**
 * chat_assert_post_rules: a top-level post obeys `posting`, a thread
 * reply `threadReplies`; channel admins pass both.
 */
export function postingBlock(i: {
  threadRootId: string | null | undefined;
  posting: ChannelRule;
  threadReplies: ChannelRule;
  channelAdmin: boolean;
}): PostingBlock | null {
  if (i.channelAdmin) return null;
  if (i.threadRootId)
    return i.threadReplies === 'admins' ? 'repliesRestricted' : null;
  return i.posting === 'admins' ? 'postingRestricted' : null;
}

/**
 * The notice's key under composer.blocked: an admins-only channel tells
 * the viewer they can still reply in threads, unless those are
 * admins-only too.
 */
export function postingBlockMessage(
  block: PostingBlock,
  threadReplies: ChannelRule
): 'postingRestricted' | 'postingRestrictedNoReplies' | 'repliesRestricted' {
  if (block === 'repliesRestricted') return block;
  return threadReplies === 'admins'
    ? 'postingRestrictedNoReplies'
    : 'postingRestricted';
}

// ---------- sensitive data (158) ----------

const USER_TOKEN =
  /<@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}>/g;

/** The body without <@uuid> tokens, whose digits could read as a card or ID. */
export const stripMentionTokens = (body: string): string =>
  body.replace(USER_TOKEN, ' ');

/** Kinds where scope 'guests' can apply: team and private channels (never a deal room or DM). */
export const guestScopedKind = (kind: ChannelKind): boolean =>
  kind === 'team' || kind === 'private';

/**
 * Does the guard's scope cover this channel: 'all' everywhere, 'guests'
 * only a team/private channel with a bank guest in it. `hasGuest` null
 * (not known, the lookup failed) does not apply: the database decides.
 */
export function sensitiveScopeApplies(i: {
  scope: SensitiveGuard['scope'];
  kind: ChannelKind;
  hasGuest: boolean | null;
}): boolean {
  if (i.scope === 'all') return true;
  return guestScopedKind(i.kind) && i.hasGuest === true;
}

/** Whether the channel's guest status has to be looked up before deciding. */
export const needsGuestLookup = (
  guard: SensitiveGuard,
  kind: ChannelKind,
  kinds: readonly string[]
): boolean =>
  kinds.length > 0 &&
  guard.mode !== 'off' &&
  guard.scope === 'guests' &&
  guestScopedKind(kind);

export type SensitiveKind = 'card' | 'emirates_id' | 'iban';

export type SensitiveDecision =
  | { action: 'send' }
  | { action: 'warn'; kinds: SensitiveKind[]; guests: boolean }
  | { action: 'block'; kinds: SensitiveKind[] };

/** What Send does with a text message carrying `kinds`. */
export function sensitiveDecision(i: {
  kinds: readonly SensitiveKind[];
  guard: SensitiveGuard;
  kind: ChannelKind;
  hasGuest: boolean | null;
}): SensitiveDecision {
  if (!i.kinds.length || i.guard.mode === 'off') return { action: 'send' };
  if (
    !sensitiveScopeApplies({
      scope: i.guard.scope,
      kind: i.kind,
      hasGuest: i.hasGuest,
    })
  )
    return { action: 'send' };
  return i.guard.mode === 'block'
    ? { action: 'block', kinds: [...i.kinds] }
    : {
        action: 'warn',
        kinds: [...i.kinds],
        guests: i.guard.scope === 'guests',
      };
}
