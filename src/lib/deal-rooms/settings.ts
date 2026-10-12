/**
 * Deal rooms — the account's group-invite template (`deal_room_settings`,
 * migration 088).
 *
 * The invite is a 1:1 template whose `group_id` body parameter Meta
 * turns into the group's invite link. It has to be an unedited copy of
 * Meta's Template Library template (topic `group_invite_link`), approved
 * in the WABA of the account's Meta number; an Arabic copy is optional.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_INVITE_LANGUAGE = 'en';
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;

export interface DealRoomSettings {
  inviteTemplateName: string | null;
  inviteTemplateLanguage: string;
  inviteTemplateNameAr: string | null;
  updatedAt: string | null;
}

interface SettingsRow {
  invite_template_name: string | null;
  invite_template_language: string | null;
  invite_template_name_ar: string | null;
  updated_at: string | null;
}

/** The saved settings; defaults when the account never saved any. */
export async function loadDealRoomSettings(
  db: SupabaseClient,
  accountId: string
): Promise<DealRoomSettings> {
  const { data, error } = await db
    .from('deal_room_settings')
    .select(
      'invite_template_name, invite_template_language, invite_template_name_ar, updated_at'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    throw new Error(`deal room settings lookup failed: ${error.message}`);
  }
  const row = (data ?? {}) as Partial<SettingsRow>;
  return {
    inviteTemplateName: row.invite_template_name ?? null,
    inviteTemplateLanguage:
      row.invite_template_language ?? DEFAULT_INVITE_LANGUAGE,
    inviteTemplateNameAr: row.invite_template_name_ar ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * The copy to send: the Arabic one to someone known to prefer Arabic,
 * when it is set, else the default. Null when nothing is configured.
 */
export function pickInviteTemplate(
  settings: DealRoomSettings,
  preferredLanguage?: string | null
): { name: string; language: string } | null {
  if (
    preferredLanguage?.toLowerCase().startsWith('ar') &&
    settings.inviteTemplateNameAr
  ) {
    return { name: settings.inviteTemplateNameAr, language: 'ar' };
  }
  return settings.inviteTemplateName
    ? {
        name: settings.inviteTemplateName,
        language: settings.inviteTemplateLanguage,
      }
    : null;
}

export interface InviteTemplateStatus {
  name: string;
  language: string;
  /** A `message_templates` row of this account has the name and language. */
  found: boolean;
  status: string | null;
  /** APPROVED and in Meta's registry: a Whapi-era row is APPROVED locally only. */
  ready: boolean;
}

/** Whether the named copy is synced from the WABA and APPROVED. */
export async function inviteTemplateStatus(
  db: SupabaseClient,
  accountId: string,
  name: string,
  language: string
): Promise<InviteTemplateStatus> {
  const { data, error } = await db
    .from('message_templates')
    .select('status, meta_template_id')
    .eq('account_id', accountId)
    .eq('name', name)
    .eq('language', language);
  if (error) throw new Error(`template lookup failed: ${error.message}`);
  const rows = (data ?? []) as {
    status: string | null;
    meta_template_id: string | null;
  }[];
  const ready = rows.find(
    (r) => r.status === 'APPROVED' && !!r.meta_template_id
  );
  const row = ready ?? rows[0];
  return {
    name,
    language,
    found: rows.length > 0,
    status: row?.status ?? null,
    ready: !!ready,
  };
}

export interface SettingsInput {
  invite_template_name: string | null;
  invite_template_language: string;
  invite_template_name_ar: string | null;
}

function optionalName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name) return null;
  return TEMPLATE_NAME.test(name) ? name : undefined;
}

/** `PUT /api/deal-rooms/settings` body → the row's columns. */
export function parseSettingsInput(
  body: unknown
): { ok: true; value: SettingsInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const name = optionalName(b.inviteTemplateName);
  const nameAr = optionalName(b.inviteTemplateNameAr);
  if (name === undefined || nameAr === undefined) {
    return {
      ok: false,
      error:
        'A template name is lowercase letters, digits and underscores, as Meta names it',
    };
  }
  const language =
    b.inviteTemplateLanguage === undefined || b.inviteTemplateLanguage === null
      ? DEFAULT_INVITE_LANGUAGE
      : String(b.inviteTemplateLanguage).trim();
  if (!LANGUAGE.test(language)) {
    return { ok: false, error: 'Language must be a code such as en or en_US' };
  }
  return {
    ok: true,
    value: {
      invite_template_name: name,
      invite_template_language: language,
      invite_template_name_ar: nameAr,
    },
  };
}
