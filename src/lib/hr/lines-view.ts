/**
 * Pure view logic for the "HR lines" section of HR → Rules (migration
 * 213): which WhatsApp numbers count as HR, and whether a new person
 * writing to one opens a Recruitment chat. The page fetches the numbers
 * (`GET /api/whatsapp/channels`) and the saved state (`hr_lines_get`);
 * everything it shows and saves is shaped here.
 */
import {
  isLinkedDeviceNumber,
  providerLabel,
} from '@/lib/whatsapp/channel-management';

import { decideErrorKey } from './agents/panel';
import type { HrLines } from './api';
import type { HrErrorCode } from './types';

/** The fields of a `/api/whatsapp/channels` row this section reads. */
export interface HrLineChannel {
  id: string;
  provider: string;
  label: string | null;
  waba_id: string | null;
  is_personal?: boolean | null;
  user_id?: string | null;
}

export interface HrLineRow {
  id: string;
  title: string;
  subtitle: string;
  checked: boolean;
}

/**
 * A number's name: its label, else the paired phone of a linked device
 * (Whapi, OpenWA; a Meta row's `waba_id` is the WABA id, not a phone),
 * else the provider's name.
 */
function lineTitle(c: HrLineChannel): string {
  const label = c.label?.trim();
  if (label) return label;
  if (isLinkedDeviceNumber(c.provider) && c.waba_id) return c.waba_id;
  return providerLabel(c.provider);
}

/**
 * One row per number: company numbers first, then personal numbers by
 * owner name; within each, by title. `personalOf` words the owner part
 * of the subtitle ("Personal, Sara") in the page's language.
 */
export function hrLineRows(
  channels: readonly HrLineChannel[],
  selectedIds: readonly string[],
  nameOf: (userId: string) => string | null,
  personalOf: (owner: string) => string = (o) => `Personal, ${o}`
): HrLineRow[] {
  const selected = new Set(selectedIds);
  const prepared = channels.map((c) => {
    const personal = c.is_personal === true;
    const owner = personal
      ? (c.user_id && nameOf(c.user_id)) || c.user_id || ''
      : '';
    const title = lineTitle(c);
    const provider = providerLabel(c.provider);
    return {
      personal,
      owner,
      row: {
        id: c.id,
        title,
        subtitle: personal ? `${provider} · ${personalOf(owner)}` : provider,
        checked: selected.has(c.id),
      },
    };
  });
  prepared.sort(
    (a, b) =>
      Number(a.personal) - Number(b.personal) ||
      a.owner.localeCompare(b.owner) ||
      a.row.title.localeCompare(b.row.title) ||
      a.row.id.localeCompare(b.row.id)
  );
  return prepared.map((p) => p.row);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** True when the draft differs from what was saved (order ignored). */
export function isDirty(saved: HrLines, draft: HrLines): boolean {
  return (
    saved.auto_open_recruiter !== draft.auto_open_recruiter ||
    !sameIds(saved.channel_ids, draft.channel_ids)
  );
}

/** The draft with one number ticked or unticked. */
export function toggleLine(
  draft: HrLines,
  id: string,
  checked: boolean
): HrLines {
  const rest = draft.channel_ids.filter((c) => c !== id);
  return { ...draft, channel_ids: checked ? [...rest, id] : rest };
}

/**
 * `hr_lines_set`'s arguments: unique ids, sorted like the RPC's answer,
 * and the version the list was loaded with (compare-and-set).
 */
export function hrLinesPayload(draft: HrLines): {
  channelIds: string[];
  autoOpen: boolean;
  expected: string | null;
} {
  return {
    channelIds: [...new Set(draft.channel_ids)].sort(),
    autoOpen: draft.auto_open_recruiter,
    expected: draft.updated_at,
  };
}

/**
 * What a refused save shows (a key under `Hr`), and whether the page
 * reloads the lines and the numbers. STALE: another admin saved since
 * this page loaded. INVALID: a ticked number is no longer a number of
 * the workspace (deleted after the page loaded). Both are fixed only by
 * reloading, so the person checks the fresh list and saves again.
 */
export function linesSaveError(code: HrErrorCode): {
  key: string;
  reload: boolean;
} {
  if (code === 'STALE') return { key: 'setup.lines.stale', reload: true };
  if (code === 'INVALID') {
    return { key: 'setup.lines.numberRemoved', reload: true };
  }
  return { key: decideErrorKey(code), reload: false };
}
