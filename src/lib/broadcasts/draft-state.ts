import type {
  AudienceConfig,
  VariableMapping,
} from '@/hooks/use-broadcast-sending';
import type { QuietHours } from '@/lib/broadcasts/quiet-hours';
import { normalizeNarrowing } from '@/lib/broadcasts/audience-narrow';

/**
 * A saved broadcast draft (migration 252, `broadcasts.draft_state`): the
 * whole wizard, so "Open draft" lands where the person left off. Pure and
 * JSON-safe; the page does the I/O.
 */

/** A CSV audience bigger than this is not stored: re-upload it. */
export const DRAFT_CSV_MAX_ROWS = 5000;

export const DRAFT_STATE_VERSION = 1;

export interface WizardDraftState {
  v: typeof DRAFT_STATE_VERSION;
  template: { name: string; language: string } | null;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl: string;
  name: string;
  /** ISO string; a past time is dropped when the draft is reopened. */
  scheduledAt: string | null;
  quietHours: QuietHours | null;
  followUpFlowId: string | null;
  /** The CSV was too large to keep: the audience step asks again. */
  csvDropped: boolean;
}

export interface DraftInput {
  template: { name: string; language?: string | null } | null;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl: string;
  name: string;
  scheduledAt: Date | null;
  quietHours: QuietHours | null;
  followUpFlowId: string | null;
}

/**
 * The audience as stored. The Compass sample fields are previews read
 * for the personalize step and re-read on reopen, so they are left out;
 * an oversized CSV is left out and flagged.
 */
export function serializeAudience(audience: AudienceConfig): {
  audience: AudienceConfig;
  csvDropped: boolean;
} {
  const {
    compassSample: _s,
    compassSampleRows: _r,
    compassSampleKey: _k,
    ...rest
  } = audience;
  void _s;
  void _r;
  void _k;
  const rows = rest.csvContacts?.length ?? 0;
  if (rows > DRAFT_CSV_MAX_ROWS) {
    const { csvContacts: _c, ...withoutCsv } = rest;
    void _c;
    return { audience: withoutCsv, csvDropped: true };
  }
  return { audience: rest, csvDropped: false };
}

export function serializeDraft(input: DraftInput): WizardDraftState {
  const { audience, csvDropped } = serializeAudience(input.audience);
  return {
    v: DRAFT_STATE_VERSION,
    template: input.template
      ? {
          name: input.template.name,
          language: input.template.language ?? 'en_US',
        }
      : null,
    audience,
    variables: input.variables,
    headerMediaUrl: input.headerMediaUrl,
    name: input.name,
    scheduledAt: input.scheduledAt ? input.scheduledAt.toISOString() : null,
    quietHours: input.quietHours,
    followUpFlowId: input.followUpFlowId,
    csvDropped,
  };
}

const AUDIENCE_TYPES = ['all', 'chat_tags', 'custom_field', 'csv', 'compass'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read a stored `draft_state`, tolerantly: null for anything that is not
 * a version-1 object, defaults for missing parts, narrowing keys
 * normalised (an old row has none, which means today's behaviour).
 */
export function deserializeDraft(raw: unknown): WizardDraftState | null {
  if (!isRecord(raw) || raw.v !== DRAFT_STATE_VERSION) return null;
  const a = isRecord(raw.audience) ? raw.audience : {};
  const type = AUDIENCE_TYPES.includes(a.type as string)
    ? (a.type as AudienceConfig['type'])
    : 'all';
  const audience = { ...a, type } as unknown as AudienceConfig;
  const n = normalizeNarrowing(a);
  audience.chatTagMatch = n.chatTagMatch;
  audience.bankCodes = n.bankCodes.length ? n.bankCodes : undefined;
  audience.bankSource = n.bankSource;
  audience.leadSources = n.leadSources.length ? n.leadSources : undefined;

  const t = isRecord(raw.template) ? raw.template : null;
  const template =
    t && typeof t.name === 'string' && t.name
      ? {
          name: t.name,
          language: typeof t.language === 'string' ? t.language : 'en_US',
        }
      : null;
  const qh = isRecord(raw.quietHours) ? raw.quietHours : null;
  const quietHours =
    qh &&
    typeof qh.start === 'string' &&
    typeof qh.end === 'string' &&
    typeof qh.tz === 'string'
      ? ({ start: qh.start, end: qh.end, tz: qh.tz } as QuietHours)
      : null;
  return {
    v: DRAFT_STATE_VERSION,
    template,
    audience,
    variables: isRecord(raw.variables)
      ? (raw.variables as Record<string, VariableMapping>)
      : {},
    headerMediaUrl:
      typeof raw.headerMediaUrl === 'string' ? raw.headerMediaUrl : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    scheduledAt:
      typeof raw.scheduledAt === 'string' &&
      !Number.isNaN(Date.parse(raw.scheduledAt))
        ? raw.scheduledAt
        : null,
    quietHours,
    followUpFlowId:
      typeof raw.followUpFlowId === 'string' ? raw.followUpFlowId : null,
    csvDropped: raw.csvDropped === true,
  };
}

/** Is the audience complete enough to move past step 2? */
export function isAudienceComplete(audience: AudienceConfig): boolean {
  switch (audience.type) {
    case 'all':
    case 'compass':
      return true;
    case 'chat_tags':
      return (audience.chatTagIds?.length ?? 0) > 0;
    case 'custom_field':
      return !!(audience.customField?.fieldId && audience.customField.value);
    case 'csv':
      return (audience.csvContacts?.length ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * The step a reopened draft lands on: 0 template, 1 audience, 2
 * personalize, 3 schedule/send. Never past a step whose input is
 * missing, so Next stays honest.
 */
export function draftResumeStep(
  state: Pick<WizardDraftState, 'audience' | 'name'>,
  templateFound: boolean
): 0 | 1 | 2 | 3 {
  if (!templateFound) return 0;
  if (!isAudienceComplete(state.audience)) return 1;
  return state.name.trim() ? 3 : 2;
}

/** A schedule already in the past is dropped on reopen. */
export function reopenedScheduledAt(
  iso: string | null,
  now: Date = new Date()
): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return d.getTime() > now.getTime() ? d : null;
}
