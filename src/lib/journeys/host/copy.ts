/**
 * Copy for the journey bot's SESSION messages (free-form, inside the
 * 24-hour window) and the titles of every quick-reply payload in the
 * shipped workflow.
 *
 * THIS IS DEFAULT, EDITABLE COPY — placeholder English wording, not
 * approved marketing text. An account overrides any key through
 * `journey_settings.copy` (migration 086), merged over these defaults
 * key by key: `{ "messages": { "<template>": { "body": "…" } },
 * "titles": { "<PAYLOAD>": "…" } }`.
 *
 * Templates (MARKETING / UTILITY) are not here: their wording is the
 * account's `message_templates` row, approved by Meta.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TemplateDef } from '../schema';
import { JourneyDbError } from './store';

/** WhatsApp limits: reply-button titles, list-row titles, the list's button label. */
export const REPLY_BUTTON_TITLE_MAX = 20;
export const LIST_ROW_TITLE_MAX = 24;
export const LIST_BUTTON_LABEL_MAX = 20;

export interface SessionCopy {
  body: string;
  /** List messages: the label of the button that opens the list. */
  buttonLabel?: string;
  /** Copy per `SEND.variant` (callback_ack: IN_HOURS | OUT_OF_HOURS); `body` when the variant has none. */
  variants?: Record<string, string>;
}

export interface JourneyCopy {
  /** SESSION template name → its copy. */
  messages: Record<string, SessionCopy>;
  /** Workflow payload id → the button / list-row title the customer sees. */
  titles: Record<string, string>;
}

export const DEFAULT_COPY: JourneyCopy = {
  messages: {
    welcome_menu: {
      body: 'Welcome to Taamul! What can we help your business with today?',
    },
    pos_pitch_in_window: {
      body: 'We can set your business up with a POS terminal through our partner banks. How would you like to continue?',
      buttonLabel: 'Choose an option',
    },
    acct_pitch_in_window: {
      body: 'We can help you open a business account with one of our partner banks. Shall we check your eligibility?',
    },
    loan_pitch_in_window: {
      body: 'We can help you find a business loan through our partner banks. Shall we check your eligibility?',
    },
    callback_ack: {
      body: 'An advisor will call you shortly.',
      variants: {
        IN_HOURS: 'An advisor will call you shortly.',
        OUT_OF_HOURS: 'An advisor will call you tomorrow from 9 am.',
      },
    },
  },
  titles: {
    POS: 'POS terminal',
    ACCOUNT: 'Business account',
    LOAN: 'Business loan',
    QUOTE: 'Get a quote',
    COMPARE: 'Compare my rates',
    ADVISOR: 'Talk to an advisor',
    NOT_NOW: 'Not now',
    PROCEED: 'Proceed',
    CHECK_ELIGIBILITY: 'Check eligibility',
    SENDING_NOW: 'Sending now',
    NEED_MORE_TIME: 'Need more time',
    CONFIRM: 'Confirm',
    CHANGE_SLOT: 'Change slot',
    ACCEPT: 'Accept',
    REJECT: 'Reject',
    REFER: 'Refer a friend',
    CROSS_SELL: 'Other products',
    YES_CONTINUE: 'Yes, continue',
    UPLOAD_HELP: 'How to upload',
    CALL_ME_BACK: 'Call me back',
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * The defaults with an account's overrides on top. Tolerant: anything
 * that is not a non-blank string where one is expected is ignored, so a
 * hand-edited row can never break a send.
 */
export function mergeCopy(overrides: unknown): JourneyCopy {
  const messages: Record<string, SessionCopy> = {};
  for (const [name, c] of Object.entries(DEFAULT_COPY.messages))
    messages[name] = {
      ...c,
      ...(c.variants ? { variants: { ...c.variants } } : {}),
    };
  const titles = { ...DEFAULT_COPY.titles };
  if (!isRecord(overrides)) return { messages, titles };
  if (isRecord(overrides.messages))
    for (const [name, o] of Object.entries(overrides.messages)) {
      if (!isRecord(o)) continue;
      const base: SessionCopy = messages[name] ?? { body: '' };
      const variants = { ...base.variants };
      if (isRecord(o.variants))
        for (const [k, v] of Object.entries(o.variants))
          if (text(v)) variants[k] = text(v)!;
      const merged: SessionCopy = {
        body: text(o.body) ?? base.body,
        ...((text(o.buttonLabel) ?? base.buttonLabel)
          ? { buttonLabel: text(o.buttonLabel) ?? base.buttonLabel }
          : {}),
        ...(Object.keys(variants).length ? { variants } : {}),
      };
      if (merged.body) messages[name] = merged;
    }
  if (isRecord(overrides.titles))
    for (const [id, t] of Object.entries(overrides.titles))
      if (text(t)) titles[id] = text(t)!;
  return { messages, titles };
}

/** The account's copy: `journey_settings.copy` over the defaults. */
export async function loadJourneyCopy(
  db: SupabaseClient,
  accountId: string
): Promise<JourneyCopy> {
  const { data, error } = await db
    .from('journey_settings')
    .select('copy')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new JourneyDbError('journey_settings', error);
  return mergeCopy((data as { copy?: unknown } | null)?.copy);
}

const clip = (s: string, max: number) =>
  [...s].length > max ? [...s].slice(0, max).join('').trimEnd() : s;

export type SessionMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | {
      kind: 'list';
      body: string;
      buttonLabel: string;
      rows: { id: string; title: string }[];
    };

/**
 * A SESSION message ready to send: plain text when the template has no
 * buttons (callback_ack, by variant), else reply buttons or a list whose
 * button / row ids are the workflow payload ids, so a tap comes back as
 * the payload itself. Null when there is no copy for the template.
 */
export function renderSession(
  name: string,
  def: TemplateDef,
  copy: JourneyCopy,
  variant?: string
): SessionMessage | null {
  const c = copy.messages[name];
  if (!c) return null;
  const body = (variant !== undefined && c.variants?.[variant]) || c.body;
  if (!def.buttons.length) return { kind: 'text', text: body };
  const title = (id: string, max: number) => clip(copy.titles[id] ?? id, max);
  if (def.interactive === 'list')
    return {
      kind: 'list',
      body,
      buttonLabel: clip(
        c.buttonLabel ?? 'Choose an option',
        LIST_BUTTON_LABEL_MAX
      ),
      rows: def.buttons.map((id) => ({
        id,
        title: title(id, LIST_ROW_TITLE_MAX),
      })),
    };
  return {
    kind: 'buttons',
    body,
    buttons: def.buttons.map((id) => ({
      id,
      title: title(id, REPLY_BUTTON_TITLE_MAX),
    })),
  };
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The workflow payload id an inbound reply stands for, or null. A session
 * interactive reply comes back as the button / row id (the payload id
 * itself); a Meta template quick reply comes back as the button TEXT
 * (`button.payload` = the title when no payload param was sent). Titles
 * match case- and space-insensitively against the account's copy, then
 * against the defaults (a template approved with the default wording).
 */
export function payloadForReply(
  textOrId: string,
  copy: JourneyCopy = DEFAULT_COPY
): string | null {
  const raw = textOrId.trim();
  if (!raw) return null;
  if (
    Object.hasOwn(copy.titles, raw) ||
    Object.hasOwn(DEFAULT_COPY.titles, raw)
  )
    return raw;
  const wanted = norm(raw);
  for (const titles of [copy.titles, DEFAULT_COPY.titles])
    for (const [id, title] of Object.entries(titles))
      if (norm(title) === wanted) return id;
  return null;
}
