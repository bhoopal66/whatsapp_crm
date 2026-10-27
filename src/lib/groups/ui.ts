/**
 * Pure logic behind the Groups screen and the create wizard: parsing
 * typed phone numbers, merging them with picked contacts, step
 * validation, grouping the create result, and the list's search and
 * "last activity" label. No I/O, so it is tested in node.
 *
 * Client-safe on purpose: `lib/whatsapp/groups.ts` imports the gateway
 * client, which must stay out of the browser bundle, so its limits are
 * restated here and `ui.test.ts` checks they still agree.
 */
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { validateContactPhone } from '@/lib/contacts/phone-validation';

import { GROUP_ADD_POLICY } from './limits';
import type { GroupOurRole, GroupPolicy, GroupSetting } from './types';

/** WhatsApp's limit on a group's name (`GROUP_NAME_MAX`). */
export const GROUP_NAME_MAX = 100;
/** WhatsApp's limit on a group's description. */
export const GROUP_DESCRIPTION_MAX = 2048;
/** `GROUP_ADD_POLICY` (limits.ts, client-safe): per call, the pause, the cap. */
export const GROUP_ADD_BATCH = GROUP_ADD_POLICY.batchSize;
export const GROUP_ADD_PAUSE_SECONDS = GROUP_ADD_POLICY.pauseMs / 1000;
export const GROUP_MEMBERS_PER_OPERATION = GROUP_ADD_POLICY.maxPerOperation;

// ------------------------------------------------------------
// The list
// ------------------------------------------------------------

export interface GroupListItem {
  id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  participants_count: number;
  our_role: GroupOurRole;
  channel_id: string | null;
  channel: { id: string; name: string | null; phone: string | null } | null;
  last_message_at: string | null;
  created_by: string | null;
  can_manage: boolean;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

/** Tolerant read of `GET /api/whatsapp/groups`; malformed rows drop. */
export function parseGroupList(json: unknown): GroupListItem[] {
  const raw = (json as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(raw)) return [];
  const out: GroupListItem[] = [];
  for (const g of raw) {
    if (typeof g !== 'object' || g === null) continue;
    const r = g as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    const ch = r.channel as Record<string, unknown> | null | undefined;
    const role = r.our_role;
    out.push({
      id,
      name: str(r.name) ?? '',
      description: str(r.description),
      icon_url: str(r.icon_url),
      participants_count:
        typeof r.participants_count === 'number' && r.participants_count > 0
          ? r.participants_count
          : 0,
      our_role:
        role === 'admin' || role === 'left' ? role : ('member' as const),
      channel_id: str(r.channel_id),
      channel:
        ch && typeof ch === 'object' && str(ch.id)
          ? { id: str(ch.id)!, name: str(ch.name), phone: str(ch.phone) }
          : null,
      last_message_at: str(r.last_message_at),
      created_by: str(r.created_by),
      can_manage: r.can_manage === true,
    });
  }
  return out;
}

/**
 * Search by name, description or number (case-insensitive). Groups we
 * left sink below the rest; otherwise the latest activity comes first.
 */
export function filterGroups(
  groups: readonly GroupListItem[],
  query: string
): GroupListItem[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const hit = (g: GroupListItem) =>
    !q ||
    g.name.toLowerCase().includes(q) ||
    (g.description ?? '').toLowerCase().includes(q) ||
    (g.channel?.name ?? '').toLowerCase().includes(q) ||
    (digits.length >= 3 &&
      (g.channel?.phone ?? '').replace(/\D/g, '').includes(digits));
  const ts = (g: GroupListItem) =>
    g.last_message_at ? Date.parse(g.last_message_at) || 0 : 0;
  return groups
    .filter(hit)
    .sort(
      (a, b) =>
        Number(a.our_role === 'left') - Number(b.our_role === 'left') ||
        ts(b) - ts(a) ||
        a.name.localeCompare(b.name)
    );
}

/** Up to two letters for an avatar with no icon. */
export function groupInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '#';
  const first = (w: string) => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '';
  const letters =
    words.length === 1
      ? [...words[0].replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('')
      : first(words[0]) + first(words[1]);
  return letters.toUpperCase() || '#';
}

export type RelativeActivity =
  | { unit: 'none' }
  | { unit: 'now' }
  | { unit: 'minute' | 'hour' | 'day'; value: number }
  | { unit: 'date'; date: Date };

/**
 * "Last activity" bucket: under a minute is now, then minutes, hours,
 * and days up to a week; older is a date. A clock a little ahead of
 * the server's is still "now", never "in 2 minutes".
 */
export function relativeActivity(
  iso: string | null,
  now: Date
): RelativeActivity {
  if (!iso) return { unit: 'none' };
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return { unit: 'none' };
  const seconds = Math.max(0, (now.getTime() - at) / 1000);
  if (seconds < 60) return { unit: 'now' };
  if (seconds < 3600)
    return { unit: 'minute', value: Math.floor(seconds / 60) };
  if (seconds < 86_400)
    return { unit: 'hour', value: Math.floor(seconds / 3600) };
  if (seconds < 7 * 86_400)
    return { unit: 'day', value: Math.floor(seconds / 86_400) };
  return { unit: 'date', date: new Date(at) };
}

// ------------------------------------------------------------
// The wizard: members
// ------------------------------------------------------------

export interface TypedNumber {
  /** As the person typed it. */
  input: string;
  /** Normalised digits, or null when it is not a usable number. */
  waId: string | null;
  /** English reason when refused (the validator's sentence). */
  error?: string;
}

/**
 * The "add phone numbers" box: one per line, or separated by commas or
 * semicolons. Each is checked with the contact phone validator; a
 * number typed twice (in any format) is kept once.
 */
export function parsePhoneList(text: string): TypedNumber[] {
  const out: TypedNumber[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\n\r,;]+/)) {
    const input = part.trim();
    if (!input) continue;
    const checked = validateContactPhone(input);
    if (!checked.ok) {
      out.push({ input, waId: null, error: checked.error });
      continue;
    }
    if (seen.has(checked.normalized)) continue;
    seen.add(checked.normalized);
    out.push({ input, waId: checked.normalized });
  }
  return out;
}

export interface PickedContact {
  id: string;
  name: string | null;
  phone: string | null;
}

export interface WizardMember {
  waId: string;
  name: string | null;
  contactId: string | null;
}

export interface MergedMembers {
  /** Everyone to add, contacts first, each number once. */
  members: WizardMember[];
  /** Picked contacts whose stored number is not usable. */
  unusableContacts: PickedContact[];
  /** Typed entries that are not numbers. */
  invalidTyped: TypedNumber[];
}

/**
 * Picked contacts plus typed numbers, de-duplicated on the normalised
 * number: a typed number that is also a picked contact is that contact.
 */
export function mergeMembers(
  contacts: readonly PickedContact[],
  typed: readonly TypedNumber[]
): MergedMembers {
  const members: WizardMember[] = [];
  const unusableContacts: PickedContact[] = [];
  const byWaId = new Map<string, WizardMember>();
  for (const c of contacts) {
    const checked = c.phone ? validateContactPhone(c.phone) : null;
    if (!checked?.ok) {
      unusableContacts.push(c);
      continue;
    }
    if (byWaId.has(checked.normalized)) continue;
    const m = { waId: checked.normalized, name: c.name, contactId: c.id };
    byWaId.set(m.waId, m);
    members.push(m);
  }
  for (const t of typed) {
    if (!t.waId || byWaId.has(t.waId)) continue;
    const m = { waId: t.waId, name: null, contactId: null };
    byWaId.set(m.waId, m);
    members.push(m);
  }
  return {
    members,
    unusableContacts,
    invalidTyped: typed.filter((t) => !t.waId),
  };
}

// ------------------------------------------------------------
// The wizard: steps and the request
// ------------------------------------------------------------

export const WIZARD_STEPS = ['basics', 'members', 'settings'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The four switches, each on meaning "admins only" for that setting. */
export type AdminOnlyToggles = Record<GroupSetting, boolean>;

/**
 * New groups start tidy: only admins edit the name and picture and add
 * people; anyone may write, and joining by link needs no approval.
 */
export const DEFAULT_TOGGLES: AdminOnlyToggles = {
  send_messages: false,
  edit_group_info: true,
  approve_participants: false,
  add_participants: true,
};

export interface WizardValues {
  channelId: string | null;
  name: string;
  description: string;
  contacts: PickedContact[];
  typedText: string;
  toggles: AdminOnlyToggles;
  managerIds: string[];
}

export type WizardError =
  | 'numberRequired'
  | 'nameRequired'
  | 'nameTooLong'
  | 'descriptionTooLong'
  | 'membersRequired'
  | 'fixInvalidNumbers';

/** Name length as WhatsApp counts it: by character, not UTF-16 unit. */
export function nameLength(name: string): number {
  return [...name.trim()].length;
}

/** Why `step` cannot be left forwards, or null. */
export function validateStep(
  step: WizardStep,
  values: WizardValues
): WizardError | null {
  if (step === 'basics') {
    if (!values.channelId) return 'numberRequired';
    if (!values.name.trim()) return 'nameRequired';
    if (nameLength(values.name) > GROUP_NAME_MAX) return 'nameTooLong';
    if ([...values.description.trim()].length > GROUP_DESCRIPTION_MAX)
      return 'descriptionTooLong';
    return null;
  }
  if (step === 'members') {
    const merged = mergeMembers(
      values.contacts,
      parsePhoneList(values.typedText)
    );
    if (merged.invalidTyped.length > 0) return 'fixInvalidNumbers';
    if (merged.members.length === 0) return 'membersRequired';
    return null;
  }
  return null;
}

/** The first step with a problem, for the submit button's last check. */
export function firstInvalidStep(
  values: WizardValues
): { step: WizardStep; error: WizardError } | null {
  for (const step of WIZARD_STEPS) {
    const error = validateStep(step, values);
    if (error) return { step, error };
  }
  return null;
}

export interface CreateGroupBody {
  channelId: string;
  name: string;
  description?: string;
  participants: string[];
  contactIds?: string[];
  settings: Record<GroupSetting, GroupPolicy>;
  managerIds?: string[];
}

/** `POST /api/whatsapp/groups` body. Call only once every step is valid. */
export function buildCreateBody(values: WizardValues): CreateGroupBody {
  const merged = mergeMembers(
    values.contacts,
    parsePhoneList(values.typedText)
  );
  const contactIds = merged.members
    .map((m) => m.contactId)
    .filter((id): id is string => id !== null);
  const policy = (on: boolean): GroupPolicy => (on ? 'admins' : 'anyone');
  const description = values.description.trim();
  return {
    channelId: values.channelId ?? '',
    name: values.name.trim(),
    ...(description ? { description } : {}),
    participants: merged.members.map((m) => m.waId),
    ...(contactIds.length ? { contactIds } : {}),
    settings: {
      send_messages: policy(values.toggles.send_messages),
      edit_group_info: policy(values.toggles.edit_group_info),
      approve_participants: policy(values.toggles.approve_participants),
      add_participants: policy(values.toggles.add_participants),
    },
    ...(values.managerIds.length
      ? { managerIds: [...new Set(values.managerIds)] }
      : {}),
  };
}

// ------------------------------------------------------------
// The result
// ------------------------------------------------------------

export interface CreateGroupResult {
  groupId: string | null;
  added: string[];
  refused: string[];
  notAttempted: string[];
  invalid: string[];
  /** Left out because they opted out or are do-not-contact. */
  skipped: SkippedPerson[];
  warnings: string[];
}

export interface SkippedPerson {
  waId: string;
  reason: 'opted_out' | 'do_not_contact';
}

function skippedList(v: unknown): SkippedPerson[] {
  if (!Array.isArray(v)) return [];
  const out: SkippedPerson[] = [];
  for (const s of v) {
    const r = (s ?? {}) as { waId?: unknown; reason?: unknown };
    if (typeof r.waId !== 'string') continue;
    out.push({
      waId: r.waId,
      reason: r.reason === 'do_not_contact' ? 'do_not_contact' : 'opted_out',
    });
  }
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/**
 * The people in a result list as phone/wa ids. The routes return whole
 * identities (`{ jid, waId }`, `waId` null when the gateway only gave a
 * jid); a bare string is still accepted.
 */
export function identityIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const r = (item ?? {}) as { waId?: unknown; jid?: unknown };
    if (typeof r.waId === 'string' && r.waId) out.push(r.waId);
    else if (typeof r.jid === 'string' && r.jid) {
      out.push(r.jid.replace(/@.*$/, ''));
    }
  }
  return out;
}

/** Tolerant read of the create response. */
export function parseCreateResult(json: unknown): CreateGroupResult {
  const r = (json ?? {}) as Record<string, unknown>;
  const group = r.group as { id?: unknown } | null | undefined;
  return {
    groupId: str(group?.id),
    added: identityIds(r.added),
    refused: identityIds(r.refused),
    notAttempted: identityIds(r.notAttempted),
    invalid: strings(r.invalid),
    skipped: skippedList(r.skipped),
    warnings: strings(r.warnings),
  };
}

export interface ResultPerson {
  waId: string;
  name: string | null;
}

export interface ResultSummary {
  /** In the group now (green). */
  added: ResultPerson[];
  /** WhatsApp refused them: send the invite link (amber). */
  refused: ResultPerson[];
  /** Past the per-operation cap, or stopped early: invite link too (amber). */
  notAttempted: ResultPerson[];
  /** Not WhatsApp numbers (red). */
  invalid: ResultPerson[];
  /** Left out for consent: no invite link either. */
  skipped: Array<ResultPerson & { reason: SkippedPerson['reason'] }>;
  /** Everyone who still needs the invite link. */
  needInvite: number;
  /** Known `warnings` codes of the create response, once each. */
  warnings: CreateWarning[];
}

/** The create route's `warnings` codes; each has `Groups.create.warnings.<code>`. */
export const CREATE_WARNINGS = [
  'adds_stopped',
  'managers_not_saved',
  'description_not_set',
  'settings_not_set',
] as const;
export type CreateWarning = (typeof CREATE_WARNINGS)[number];

/** The create route's error codes; each has `Groups.create.errors.<key>`. */
const CREATE_ERROR_KEYS = [
  'no_participants',
  'invalid_manager',
  'invalid_body',
  'not_allowed',
  'rate_limited',
  'channel_disconnected',
  'billing',
  'gateway_unavailable',
] as const;
export type CreateErrorKey = (typeof CREATE_ERROR_KEYS)[number] | 'unknown';

/** The message key for a failed create's `code`; anything else is `unknown`. */
export function createErrorKey(code: unknown): CreateErrorKey {
  return (CREATE_ERROR_KEYS as readonly unknown[]).includes(code)
    ? (code as CreateErrorKey)
    : 'unknown';
}

/**
 * The group exists on WhatsApp but was not saved here. Submitting again
 * would create a second group, so the wizard ends instead of retrying.
 */
export function isCreatedButUnsaved(code: unknown): boolean {
  return code === 'saved_failed_run_sync';
}

/**
 * The create result in the wizard's terms, each number named by the
 * member it came from. A number listed twice keeps its best outcome
 * (added beats refused beats not attempted beats invalid).
 */
export function summarizeResult(
  result: CreateGroupResult,
  members: readonly WizardMember[]
): ResultSummary {
  const nameOf = new Map(members.map((m) => [m.waId, m.name]));
  const seen = new Set<string>();
  const take = (ids: string[]): ResultPerson[] => {
    const out: ResultPerson[] = [];
    for (const waId of ids) {
      if (seen.has(waId)) continue;
      seen.add(waId);
      out.push({ waId, name: nameOf.get(waId) ?? null });
    }
    return out;
  };
  const added = take(result.added);
  const refused = take(result.refused);
  const notAttempted = take(result.notAttempted);
  const invalid = take(result.invalid);
  const skipped = result.skipped.map((p) => ({
    waId: p.waId,
    name: nameOf.get(p.waId) ?? null,
    reason: p.reason,
  }));
  return {
    added,
    refused,
    notAttempted,
    invalid,
    skipped,
    needInvite: refused.length + notAttempted.length,
    warnings: CREATE_WARNINGS.filter((w) => result.warnings.includes(w)),
  };
}

/** `+971501234567` for a wa_id of digits; anything else as it came. */
export function formatWaId(waId: string): string {
  return /^\d+$/.test(waId) ? `+${waId}` : waId;
}

/**
 * The PostgREST `or` filter for the member search, or null for a query
 * too short to send. Characters that would break the filter's own
 * syntax (`,` `(` `)` `*` `%` `\`, quotes) are dropped rather than
 * escaped; a phone query also matches on its digits alone.
 */
export function contactSearchFilter(query: string): string | null {
  const q = query.replace(/[,()*%\\"']/g, ' ').trim();
  if (q.length < 2) return null;
  const parts = [`name.ilike.*${q}*`, `phone.ilike.*${q}*`];
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3 && digits !== q) parts.push(`phone.ilike.*${digits}*`);
  return parts.join(',');
}

/**
 * Staff who can be a group co-manager: live (the routes refuse a
 * deactivated person with `invalid_manager`), agent or above (so never a
 * bank guest), and not `excludeUserId` (the creator, already one).
 */
export function pickableManagers(
  members: ReadonlyArray<{
    user_id: string;
    full_name?: string | null;
    email?: string | null;
    account_role?: string | null;
    deactivated_at?: string | null;
  }>,
  excludeUserId: string | null | undefined
): Array<{ id: string; name: string }> {
  return members
    .filter(
      (p) =>
        p.user_id !== excludeUserId &&
        p.deactivated_at == null &&
        !!p.account_role &&
        hasMinRole(p.account_role as AccountRole, 'agent')
    )
    .map((p) => ({ id: p.user_id, name: p.full_name || p.email || '' }));
}

// ------------------------------------------------------------
// The list pane: filter chips, the number filter, avatar colours
// ------------------------------------------------------------

export const GROUP_LIST_CHIPS = ['all', 'admin', 'left'] as const;
export type GroupListChip = (typeof GROUP_LIST_CHIPS)[number];

/**
 * The list pane's chips and number filter, applied after the search.
 * "I'm admin" is our number being a group admin; "Left" the groups it
 * left. A null `channelId` means every number.
 */
export function applyGroupFilter<T extends GroupListItem>(
  groups: readonly T[],
  filter: { chip: GroupListChip; channelId: string | null }
): T[] {
  return groups.filter(
    (g) =>
      (filter.chip === 'all' || g.our_role === filter.chip) &&
      (filter.channelId === null || g.channel_id === filter.channelId)
  );
}

/**
 * The numbers the listed groups sit on, one entry each, by label. A
 * group whose number was removed has no entry: the filter can only
 * name a number that still exists.
 */
export function groupNumbers(
  groups: readonly GroupListItem[]
): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  for (const g of groups) {
    if (g.channel && !byId.has(g.channel.id)) {
      byId.set(g.channel.id, g.channel.name ?? g.channel.phone ?? g.channel.id);
    }
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * A stable colour slot (0 … `slots`-1) for an avatar with no picture,
 * from the group's id, so a group keeps its colour across reloads.
 */
export function avatarToneIndex(seed: string, slots: number): number {
  if (slots <= 0) return 0;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % slots;
}

/**
 * A side panel (group info, submission details) docks beside the chat
 * from here up, else it is a sheet. 1440px, not 1280: the app sidebar
 * (240px) and the 352px list leave the chat too narrow with a panel
 * docked any earlier.
 */
export const DOCK_QUERY = '(min-width: 1440px)';
