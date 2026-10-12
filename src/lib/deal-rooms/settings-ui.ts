/**
 * Deal rooms — the Settings panel's rules (module 014c), pure so they are
 * tested without a DOM. `PUT /api/deal-rooms/settings` stays the judge of
 * what is valid; this decides what to show and what to send.
 */

import {
  DEFAULT_INVITE_LANGUAGE,
  type DealRoomSettings,
  type InviteTemplateStatus,
} from './settings';

/** What `GET` and `PUT /api/deal-rooms/settings` answer with. */
export interface DealRoomSettingsView {
  settings: DealRoomSettings;
  /** A Meta number is connected: only the Cloud API can create groups. */
  metaNumber: boolean;
  /** The saved invite template's state; null when no name is saved. */
  template: InviteTemplateStatus | null;
  /** The saved Arabic copy's state; null when no name is saved. */
  templateAr: InviteTemplateStatus | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function templateStatus(value: unknown): InviteTemplateStatus | null {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.language !== 'string'
  ) {
    return null;
  }
  return {
    name: value.name,
    language: value.language,
    found: value.found === true,
    status: typeof value.status === 'string' ? value.status : null,
    ready: value.ready === true,
  };
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** The route's answer as a view; null when it is not shaped like one. */
export function parseSettingsView(json: unknown): DealRoomSettingsView | null {
  if (!isRecord(json) || !isRecord(json.settings)) return null;
  const s = json.settings;
  return {
    settings: {
      inviteTemplateName: stringOrNull(s.inviteTemplateName),
      inviteTemplateLanguage:
        typeof s.inviteTemplateLanguage === 'string' && s.inviteTemplateLanguage
          ? s.inviteTemplateLanguage
          : DEFAULT_INVITE_LANGUAGE,
      inviteTemplateNameAr: stringOrNull(s.inviteTemplateNameAr),
      updatedAt: stringOrNull(s.updatedAt),
    },
    metaNumber: json.metaNumber === true,
    template: templateStatus(json.template),
    templateAr: templateStatus(json.templateAr),
  };
}

/** What follows "Couldn't save:": the route's `{ error }`, else the status. */
export function saveErrorText(json: unknown, status: number): string {
  const error = isRecord(json) ? json.error : undefined;
  return typeof error === 'string' && error.trim()
    ? error.trim()
    : `HTTP ${status}`;
}

// ------------------------------------------------------------
// The form
// ------------------------------------------------------------

/** The three boxes, as typed. */
export interface SettingsDraft {
  name: string;
  language: string;
  nameAr: string;
}

/** The request body `parseSettingsInput` accepts. */
export interface SettingsBody {
  inviteTemplateName: string | null;
  inviteTemplateLanguage: string;
  inviteTemplateNameAr: string | null;
}

export function draftFrom(settings: DealRoomSettings): SettingsDraft {
  return {
    name: settings.inviteTemplateName ?? '',
    language: settings.inviteTemplateLanguage || DEFAULT_INVITE_LANGUAGE,
    nameAr: settings.inviteTemplateNameAr ?? '',
  };
}

/**
 * The draft as the route will read it: names trimmed and a blank one
 * cleared (null), a blank language the default (the route refuses an
 * empty string, and an absent one is the default).
 */
export function draftBody(draft: SettingsDraft): SettingsBody {
  return {
    inviteTemplateName: draft.name.trim() || null,
    inviteTemplateLanguage: draft.language.trim() || DEFAULT_INVITE_LANGUAGE,
    inviteTemplateNameAr: draft.nameAr.trim() || null,
  };
}

/**
 * Does saving the draft change anything? Compared as the route would
 * read both, so a stray space, or a blank language over the default,
 * is not a change.
 */
export function isDirty(
  draft: SettingsDraft,
  saved: DealRoomSettings
): boolean {
  const a = draftBody(draft);
  const b = draftBody(draftFrom(saved));
  return (
    a.inviteTemplateName !== b.inviteTemplateName ||
    a.inviteTemplateLanguage !== b.inviteTemplateLanguage ||
    a.inviteTemplateNameAr !== b.inviteTemplateNameAr
  );
}

// ------------------------------------------------------------
// The status line under a template name
// ------------------------------------------------------------

/**
 * Which `Settings.dealRooms` message names the state (`kind` is its
 * key), and in what tone. Only `ready` is good news: anything else
 * means the invite will not go out.
 */
export type TemplateLine =
  | { kind: 'ready'; tone: 'ok' }
  | { kind: 'notReady'; tone: 'warn'; status: string }
  | { kind: 'notFound'; tone: 'warn' }
  | { kind: 'notSet'; tone: 'warn' };

/**
 * One saved copy's state. `ready` is the route's verdict (APPROVED and
 * synced from the WABA) and is the only way to the `ready` line: a row
 * that is APPROVED but not ready was never synced from Meta's registry
 * (a Whapi-era row), so it reads as not among the synced templates,
 * not as "not approved (APPROVED)".
 */
export function templateLine(
  savedName: string | null,
  status: InviteTemplateStatus | null
): TemplateLine {
  if (!savedName) return { kind: 'notSet', tone: 'warn' };
  if (!status || !status.found) return { kind: 'notFound', tone: 'warn' };
  if (status.ready) return { kind: 'ready', tone: 'ok' };
  if (status.status?.toUpperCase() === 'APPROVED') {
    return { kind: 'notFound', tone: 'warn' };
  }
  return { kind: 'notReady', tone: 'warn', status: status.status ?? '—' };
}

/**
 * The line to show under each box. A status describes the SAVED name, so
 * it is shown only while the box still holds it: under a name being
 * typed it would vouch for something nobody has checked.
 *
 * The Arabic copy is optional, so with none saved it has no line (the
 * `notSet` message is about the default template).
 */
export function statusLines(
  view: DealRoomSettingsView,
  draft: SettingsDraft
): { main: TemplateLine | null; ar: TemplateLine | null } {
  const saved = view.settings;
  const body = draftBody(draft);
  const mainHolds =
    body.inviteTemplateName === saved.inviteTemplateName &&
    body.inviteTemplateLanguage === saved.inviteTemplateLanguage;
  const arHolds = body.inviteTemplateNameAr === saved.inviteTemplateNameAr;
  return {
    main: mainHolds
      ? templateLine(saved.inviteTemplateName, view.template)
      : null,
    ar:
      arHolds && saved.inviteTemplateNameAr
        ? templateLine(saved.inviteTemplateNameAr, view.templateAr)
        : null,
  };
}
