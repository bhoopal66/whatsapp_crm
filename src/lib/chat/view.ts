/**
 * Pure view helpers for the team-chat screen (J11a): what the sidebar
 * lists and in which order, how a DM is named, which presence dot a
 * person gets, avatar tints and the small formatting the timeline does.
 * Kept here, free of React, so the node test environment covers them.
 */
import { hasMinRole, isAccountRole, isBankGuest } from '@/lib/auth/roles';
import { OFFLINE_AFTER_MS } from '@/lib/presence';

import {
  CHANNEL_TOPIC_MAX,
  channelNameProblem,
  finalChannelName,
  type NameProblem,
} from './compose';
import { ChatError, type ChatErrorKey } from './errors';
import type {
  Channel,
  ChannelKind,
  ChannelMember,
  ChannelRole,
  ChannelWithMembership,
  ChatPerson,
  UnreadCount,
} from './types';

type PersonLookup = ReadonlyMap<string, Pick<ChatPerson, 'fullName'>>;

/** /chat and below render full-bleed: no shell padding, no outer scroll. */
export function isChatPath(pathname: string | null | undefined): boolean {
  return !!pathname && (pathname === '/chat' || pathname.startsWith('/chat/'));
}

/**
 * A DM is named by the people in it other than the viewer, comma-joined
 * in member order. A DM with yourself alone is named after you.
 */
export function dmDisplayName(
  memberIds: readonly string[],
  viewerId: string,
  people: PersonLookup,
  unknownName: string
): string {
  const me = viewerId.toLowerCase();
  const others = memberIds.filter((id) => id.toLowerCase() !== me);
  const ids = others.length ? others : memberIds.slice(0, 1);
  const name = (id: string) =>
    people.get(id.toLowerCase())?.fullName?.trim() || unknownName;
  return ids.map(name).join(', ');
}

/** The other members of a DM (the viewer left out). */
export function dmOthers(
  memberIds: readonly string[],
  viewerId: string
): string[] {
  const me = viewerId.toLowerCase();
  return memberIds.filter((id) => id.toLowerCase() !== me);
}

export function channelDisplayName(
  channel: Pick<ChannelWithMembership, 'kind' | 'name' | 'dmMemberIds'>,
  viewerId: string,
  people: PersonLookup,
  unknownName: string
): string {
  return channel.kind === 'dm'
    ? dmDisplayName(channel.dmMemberIds, viewerId, people, unknownName)
    : (channel.name ?? '');
}

export type PresenceDot = 'available' | 'busy' | 'offline';

/**
 * Solid green = available, red = on a call / busy, hollow ring = away or
 * offline. Offline is derived from heartbeat staleness, as everywhere
 * else (lib/presence.ts): a stale 'online' is offline.
 */
export function presenceDot(
  person: Pick<ChatPerson, 'presenceStatus' | 'lastSeenAt'> | undefined,
  now: number
): PresenceDot {
  const status = person?.presenceStatus?.toLowerCase();
  const seen = person?.lastSeenAt ? Date.parse(person.lastSeenAt) : NaN;
  if (!status || Number.isNaN(seen) || now - seen > OFFLINE_AFTER_MS)
    return 'offline';
  if (status === 'online' || status === 'available') return 'available';
  if (['on_call', 'call', 'busy', 'dnd'].includes(status)) return 'busy';
  return 'offline';
}

/** A group DM shows the liveliest of its other members. */
export function combinedPresence(dots: readonly PresenceDot[]): PresenceDot {
  if (dots.includes('available')) return 'available';
  if (dots.includes('busy')) return 'busy';
  return 'offline';
}

/** Pastel tile classes, light and dark (html[data-mode='dark']). */
export const AVATAR_TINTS = [
  'bg-rose-100 text-rose-700 [[data-mode=dark]_&]:bg-rose-500/25 [[data-mode=dark]_&]:text-rose-100',
  'bg-amber-100 text-amber-800 [[data-mode=dark]_&]:bg-amber-500/25 [[data-mode=dark]_&]:text-amber-100',
  'bg-lime-100 text-lime-800 [[data-mode=dark]_&]:bg-lime-500/25 [[data-mode=dark]_&]:text-lime-100',
  'bg-emerald-100 text-emerald-800 [[data-mode=dark]_&]:bg-emerald-500/25 [[data-mode=dark]_&]:text-emerald-100',
  'bg-sky-100 text-sky-800 [[data-mode=dark]_&]:bg-sky-500/25 [[data-mode=dark]_&]:text-sky-100',
  'bg-indigo-100 text-indigo-700 [[data-mode=dark]_&]:bg-indigo-500/25 [[data-mode=dark]_&]:text-indigo-100',
  'bg-violet-100 text-violet-700 [[data-mode=dark]_&]:bg-violet-500/25 [[data-mode=dark]_&]:text-violet-100',
  'bg-fuchsia-100 text-fuchsia-700 [[data-mode=dark]_&]:bg-fuchsia-500/25 [[data-mode=dark]_&]:text-fuchsia-100',
] as const;

/** A stable tint per user id (FNV-1a over the lower-cased id). */
export function avatarTint(userId: string | null | undefined): string {
  let h = 0x811c9dc5;
  for (const ch of (userId ?? '').toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

export function initialOf(name: string | null | undefined): string {
  const c = name?.trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}

export interface SidebarChannelRow {
  channel: ChannelWithMembership;
  name: string;
  unread: number;
  mentions: number;
  /** Muted by the viewer (091): dimmed, and only mentions stand out. */
  muted: boolean;
}

export interface SidebarSections {
  team: SidebarChannelRow[];
  dealRooms: SidebarChannelRow[];
  dms: SidebarChannelRow[];
  /** Archived team and private channels, under the same listing rule. */
  archived: SidebarChannelRow[];
}

const byName = (a: SidebarChannelRow, b: SidebarChannelRow) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  a.channel.id.localeCompare(b.channel.id);

/**
 * The sidebar's sections, each sorted by name. Team channels are listed
 * whether joined or not (RLS shows the workspace's); private channels,
 * DMs and deal rooms only when the caller is a member. An archived team
 * or private channel goes to `archived` (read-only; only 091's
 * unarchive writes to it), any other archived row nowhere.
 */
export function sidebarSections(
  channels: readonly ChannelWithMembership[],
  unread: readonly UnreadCount[],
  viewerId: string,
  people: PersonLookup,
  unknownName: string
): SidebarSections {
  const counts = new Map(unread.map((u) => [u.channelId, u]));
  const out: SidebarSections = {
    team: [],
    dealRooms: [],
    dms: [],
    archived: [],
  };
  const section: Record<ChannelKind, keyof SidebarSections> = {
    team: 'team',
    private: 'team',
    deal_room: 'dealRooms',
    dm: 'dms',
  };
  for (const channel of channels) {
    if (channel.kind !== 'team' && !channel.membership) continue;
    const managed = channel.kind === 'team' || channel.kind === 'private';
    if (channel.archivedAt && !managed) continue;
    const key = channel.archivedAt ? 'archived' : section[channel.kind];
    if (!key) continue;
    const c = counts.get(channel.id);
    out[key].push({
      channel,
      name: channelDisplayName(channel, viewerId, people, unknownName),
      unread: c?.unread ?? 0,
      mentions: c?.mentions ?? 0,
      // The membership row is reloaded on every mute; the counts (which
      // leave archived channels out) only fill in where it is missing.
      muted: channel.membership
        ? channel.membership.muted
        : (c?.muted ?? false),
    });
  }
  out.team.sort(byName);
  out.dealRooms.sort(byName);
  out.dms.sort(byName);
  out.archived.sort(byName);
  return out;
}

export interface RowEmphasis {
  /** Bold name: unread messages in a channel that is not muted. */
  bold: boolean;
  /** Greyed out: a muted channel, unless it is the open one. */
  dimmed: boolean;
  /** The mentions pill, else the plain unread count, else nothing. */
  badge: { kind: 'mentions' | 'unread'; count: number } | null;
}

/**
 * How a sidebar row stands out. The open channel shows no count. A
 * muted one (091) is dimmed and never bold, its unread count as quiet
 * as the row; its mentions pill stays as it is, since a direct @mention
 * still rings when muted.
 */
export function sidebarRowEmphasis(
  r: Pick<SidebarChannelRow, 'unread' | 'mentions' | 'muted'>,
  active: boolean
): RowEmphasis {
  if (active) return { bold: false, dimmed: false, badge: null };
  return {
    bold: !r.muted && r.unread > 0,
    dimmed: r.muted,
    badge:
      r.mentions > 0
        ? { kind: 'mentions', count: r.mentions }
        : r.unread > 0
          ? { kind: 'unread', count: r.unread }
          : null,
  };
}

/**
 * The header's Mute / Unmute (chat_set_muted, 091): the viewer's own
 * switch, offered on any channel they belong to, DMs, deal rooms and
 * archived channels included, bank guests too; nothing to a non-member.
 */
export function muteAction(
  membership: Pick<ChannelMember, 'muted'> | null | undefined
): 'mute' | 'unmute' | null {
  if (!membership) return null;
  return membership.muted ? 'unmute' : 'mute';
}

// ---------- channel settings (091) ----------

export interface ManageCtx {
  kind: ChannelKind;
  archived: boolean;
  /** The viewer's role in the channel; null when not a member. */
  myRole: ChannelRole | null;
  /** The viewer's workspace (account) role. */
  accountRole: string | null;
}

/**
 * chat_assert_can_manage_channel (091), mirrored for the UI only: the
 * database decides. Team and private channels (DMs are fixed sets, deal
 * rooms are 088's); never a bank guest; a channel admin, or a workspace
 * owner/admin, who in a private channel must be a member too (D-B1:
 * nobody manages a private channel from outside it). Archiving is the
 * caller's to judge: of the managed writes only an unarchive passes on
 * an archived channel.
 */
export function canManageChannel(c: Omit<ManageCtx, 'archived'>): boolean {
  if (c.kind !== 'team' && c.kind !== 'private') return false;
  if (!isAccountRole(c.accountRole) || isBankGuest(c.accountRole)) return false;
  if (c.kind === 'private' && !c.myRole) return false;
  return c.myRole === 'admin' || hasMinRole(c.accountRole, 'admin');
}

export interface ChannelSettingsActions {
  /** Rename, and edit or clear the topic. */
  edit: boolean;
  archive: boolean;
  unarchive: boolean;
}

/** What the channel header's settings menu offers the viewer. */
export function channelSettingsActions(c: ManageCtx): ChannelSettingsActions {
  const may = canManageChannel(c);
  return {
    edit: may && !c.archived,
    archive: may && !c.archived,
    unarchive: may && c.archived,
  };
}

/** A channel's live name and topic as the settings form changes them. */
export interface ChannelEdit {
  /** Null keeps the name (091: NULL keeps a field). */
  name: string | null;
  /** Null keeps the topic; '' clears it. */
  topic: string | null;
}

/**
 * The updateChannel call the settings form makes, or why not. A typed
 * name is normalised as at creation, and checked against the other
 * channels the viewer can see, so the unique index can still refuse
 * (errors.duplicateName); an untouched name is kept as stored, even one
 * made before that normalisation. The topic is trimmed and capped as at
 * creation, and a blank one clears it.
 */
export function channelEditInput(
  form: { name: string; topic: string },
  channel: Pick<Channel, 'id' | 'name' | 'topic'>,
  channels: readonly Pick<Channel, 'id' | 'kind' | 'name' | 'archivedAt'>[]
): ChannelEdit | NameProblem | 'unchanged' {
  let name: string | null = null;
  if (form.name.trim() !== (channel.name ?? '').trim()) {
    const others = channels.filter((c) => c.id !== channel.id);
    const problem = channelNameProblem(form.name, others);
    if (problem) return problem;
    name = finalChannelName(form.name);
    if (name === channel.name) name = null;
  }
  const typed = form.topic.trim().slice(0, CHANNEL_TOPIC_MAX);
  const topic = typed === (channel.topic ?? '').trim() ? null : typed;
  return name === null && topic === null ? 'unchanged' : { name, topic };
}

export type ChannelAdminAction = 'edit' | 'archive' | 'unarchive' | 'remove';

/**
 * The Chat.* message key for a refused channel-admin write (091). The
 * generic wording would mislead here: adminRequired means a channel
 * admin as well as a workspace owner/admin, notChannelMember an
 * owner/admin outside a private channel, and a name clash on unarchive
 * means the other channel has to be renamed first.
 */
export function channelAdminErrorKey(
  action: ChannelAdminAction,
  err: unknown
): string {
  const key = chatErrorKey(err);
  switch (key) {
    case 'adminRequired':
    case 'notChannelMember':
    case 'archived':
      return `settings.errors.${key}`;
    case 'duplicateName':
      return action === 'unarchive'
        ? 'settings.errors.unarchiveNameTaken'
        : 'errors.duplicateName';
    default:
      return `errors.${key}`;
  }
}

/**
 * The nav badge: unread messages over every channel, except that a
 * muted channel counts only its mentions, as the workspace rail does
 * (091's chat_workspace_badges): muting is what this badge must show.
 */
export function totalUnread(unread: readonly UnreadCount[]): number {
  return unread.reduce(
    (n, u) => n + Math.max(0, u.muted ? u.mentions : u.unread),
    0
  );
}

/** The inbox the WHATSAPP INBOX rows open: a team leader's is the team view. */
export function inboxBasePath(role: string | null): '/inbox' | '/team-inbox' {
  return role === 'team_leader' ? '/team-inbox' : '/inbox';
}

/** Does this role's inbox offer the by-agent filter the rows deep-link to? */
export function inboxHasAssigneeFilter(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'team_leader';
}

export interface InboxRow {
  id: string;
  kind: 'unassigned' | 'mine' | 'tag';
  /** The tag's name for kind 'tag'. */
  label: string | null;
  count: number;
  href: string;
}

/**
 * The WHATSAPP INBOX rows. Each count is what its link's filter shows:
 * Unassigned and Assigned to me only where the inbox has the by-agent
 * filter (elsewhere "Assigned to me" opens the plain inbox, which for an
 * agent already is their own chats), then each main tag with chats.
 */
export function inboxRows(i: {
  role: string | null;
  unassigned: number | null;
  mine: number | null;
  tags: readonly { id: string; name: string; count: number }[];
}): InboxRow[] {
  const base = inboxBasePath(i.role);
  const filtered = inboxHasAssigneeFilter(i.role);
  const rows: InboxRow[] = [];
  if (filtered && i.unassigned !== null)
    rows.push({
      id: 'unassigned',
      kind: 'unassigned',
      label: null,
      count: i.unassigned,
      href: `${base}?assignee=unassigned`,
    });
  if (i.mine !== null)
    rows.push({
      id: 'mine',
      kind: 'mine',
      label: null,
      count: i.mine,
      href: filtered ? `${base}?assignee=me` : base,
    });
  for (const t of i.tags)
    if (t.count > 0)
      rows.push({
        id: `tag:${t.id}`,
        kind: 'tag',
        label: t.name,
        count: t.count,
        href: `${base}?tag=${encodeURIComponent(t.id)}`,
      });
  return rows;
}

/** `**x**` runs for system posts. Unclosed markers stay literal. */
export function boldSegments(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), bold: false });
  return out;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024)
    return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** HH:MM, 24-hour, in `timeZone`. */
export function formatClock(ts: string, timeZone?: string): string {
  const d = new Date(ts.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(d);
}

/** Sidebar key of an account role's label, or null for an unknown one. */
export function roleLabelKey(role: string | null | undefined): string | null {
  switch (role) {
    case 'owner':
      return 'roleOwner';
    case 'admin':
      return 'roleAdmin';
    case 'team_leader':
      return 'roleTeamLeader';
    case 'agent':
      return 'roleAgent';
    case 'viewer':
      return 'roleViewer';
    case 'bank_guest':
      return 'roleBankGuest';
    default:
      return null;
  }
}

/** Every ChatErrorKey (the Record type makes a new key a compile error here). */
const ERROR_KEYS: Record<ChatErrorKey, true> = {
  forbidden: true,
  notFound: true,
  disabled: true,
  invalid: true,
  conflict: true,
  unknown: true,
  notWorkspaceMember: true,
  notChannelMember: true,
  archived: true,
  guestRestricted: true,
  notAuthor: true,
  messageDeleted: true,
  adminRequired: true,
  cannotShare: true,
  attachmentMissing: true,
  attachmentInvalid: true,
  fileTooLarge: true,
  tooManyFiles: true,
  uploadFailed: true,
  dmSize: true,
  lastAdmin: true,
  lastMember: true,
  pinLimit: true,
  reasonRequired: true,
  threadInvalid: true,
  bodyLength: true,
  duplicateName: true,
  nameLength: true,
  topicLength: true,
  removeSelf: true,
  notManageable: true,
};

/** The ChatError keys the screen has wording for (Chat.errors.*): all of them. */
export const UI_ERROR_KEYS = Object.keys(ERROR_KEYS) as readonly ChatErrorKey[];

/** The Chat.errors key to show for any thrown value. */
export function chatErrorKey(err: unknown): ChatErrorKey {
  return err instanceof ChatError && UI_ERROR_KEYS.includes(err.key)
    ? err.key
    : err instanceof ChatError
      ? (UI_ERROR_KEYS.find((k) => k === codeKey(err)) ?? 'unknown')
      : 'unknown';
}

const codeKey = (e: ChatError): ChatErrorKey =>
  e.code === 'NOT_FOUND' ? 'notFound' : (e.code.toLowerCase() as ChatErrorKey);
