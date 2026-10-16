// ============================================================
// WhatsApp groups — request bodies, parsed without I/O so the rules
// are tested here and every route refuses a bad body (400
// `invalid_body`) before any access check or gateway call.
// ============================================================

import { GROUP_NAME_MAX, toParticipantWaId } from '@/lib/whatsapp/groups';

import { GroupHttpError, isUuid } from './server';
import {
  GROUP_SETTINGS,
  parseGroupSettings,
  type GroupSettings,
} from './types';

export const GROUP_DESCRIPTION_MAX = 2048;
/** Raw entries one request may carry (phones, contact ids, managers). */
export const GROUP_LIST_MAX = 256;
const PHONE_INPUT_MAX = 64;
const QUERY_MAX = 100;

const bad = (message: string) =>
  new GroupHttpError(400, 'invalid_body', message);

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad('Body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > GROUP_NAME_MAX) {
    throw bad(`name must be 1-${GROUP_NAME_MAX} characters`);
  }
  return name;
}

function parseDescription(v: unknown): string {
  if (typeof v !== 'string' || v.length > GROUP_DESCRIPTION_MAX) {
    throw bad(
      `description must be text of at most ${GROUP_DESCRIPTION_MAX} characters`
    );
  }
  return v;
}

/** Known keys only, each `anyone` or `admins`. */
function parseSettings(v: unknown): GroupSettings {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw bad('settings must be an object');
  }
  const s = v as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!(GROUP_SETTINGS as readonly string[]).includes(key)) {
      throw bad(`Unknown setting ${key}`);
    }
  }
  const out = parseGroupSettings(s);
  if (Object.keys(out).length !== Object.keys(s).length) {
    throw bad("A setting's policy must be anyone or admins");
  }
  return out;
}

function parseIdList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > GROUP_LIST_MAX || !v.every(isUuid)) {
    throw bad(`${field} must be a list of at most ${GROUP_LIST_MAX} ids`);
  }
  return [...new Set(v.map((id) => id.toLowerCase()))];
}

export interface PhoneList {
  /** wa_id digits, deduplicated, in input order. */
  waIds: string[];
  /** Entries that cannot be a WhatsApp number, as given. */
  invalid: string[];
}

/**
 * Phone input from a person (any spacing, `+`, `00`, a chat id) to
 * wa_ids. An unusable entry is reported back, never thrown: one typo
 * must not cost the rest of the list.
 */
export function normalisePhoneList(inputs: readonly unknown[]): PhoneList {
  const waIds: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const waId =
      typeof input === 'string' && input.length <= PHONE_INPUT_MAX
        ? toParticipantWaId(input)
        : null;
    if (!waId) {
      invalid.push(String(input).slice(0, PHONE_INPUT_MAX));
    } else if (!seen.has(waId)) {
      seen.add(waId);
      waIds.push(waId);
    }
  }
  return { waIds, invalid };
}

export interface GroupPatch {
  name?: string;
  description?: string;
  settings: GroupSettings;
}

/** PATCH /api/whatsapp/groups/[id]: at least one of name, description, settings. */
export function parsePatch(raw: unknown): GroupPatch {
  const b = asObject(raw);
  const out: GroupPatch = { settings: {} };
  if (b.name !== undefined) out.name = parseName(b.name);
  if (b.description !== undefined) {
    out.description = parseDescription(b.description);
  }
  if (b.settings !== undefined) out.settings = parseSettings(b.settings);
  if (
    out.name === undefined &&
    out.description === undefined &&
    Object.keys(out.settings).length === 0
  ) {
    throw bad('Nothing to change');
  }
  return out;
}

export interface GroupCreate {
  channelId: string;
  name: string;
  /** Empty means none: WhatsApp starts a group without one. */
  description: string;
  participants: PhoneList;
  contactIds: string[];
  settings: GroupSettings;
  managerIds: string[];
}

/**
 * POST /api/whatsapp/groups. `participants` (phones) and `contactIds`
 * together must name someone; which of them are usable is only known
 * once contact ids are resolved, so an all-invalid phone list is not a
 * 400 here.
 */
export function parseCreate(raw: unknown): GroupCreate {
  const b = asObject(raw);
  if (!isUuid(b.channelId)) throw bad('channelId must be a number id');
  const name = parseName(b.name);
  const description =
    b.description === undefined || b.description === null
      ? ''
      : parseDescription(b.description).trim();
  const rawPhones = b.participants ?? [];
  if (!Array.isArray(rawPhones) || rawPhones.length > GROUP_LIST_MAX) {
    throw bad(
      `participants must be a list of at most ${GROUP_LIST_MAX} numbers`
    );
  }
  const contactIds = parseIdList(b.contactIds, 'contactIds');
  if (rawPhones.length === 0 && contactIds.length === 0) {
    throw bad('A group needs at least one participant');
  }
  return {
    channelId: b.channelId.toLowerCase(),
    name,
    description,
    participants: normalisePhoneList(rawPhones),
    contactIds,
    settings: b.settings === undefined ? {} : parseSettings(b.settings),
    managerIds: parseIdList(b.managerIds, 'managerIds'),
  };
}

/**
 * `?q=` as a PostgREST `ilike` "contains" pattern: `%`, `_` and `\`
 * match themselves; `*` (PostgREST's own wildcard, which cannot be
 * escaped) becomes a one-character wildcard. Blank → null (no filter).
 */
export function nameSearchPattern(q: string | null): string | null {
  const term = (q ?? '').trim().slice(0, QUERY_MAX);
  if (!term) return null;
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_');
  return `%${escaped}%`;
}
