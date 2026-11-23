/**
 * Deleting customers (migration 280): what goes with them, who cannot be
 * deleted and why, read from `contact_delete_preview` and from a refused
 * DELETE. Pure: `delete-contacts.ts` makes the calls, and
 * `delete-contacts-dialog.tsx` shows the answer.
 */

export const DELETE_PREVIEW_RPC = 'contact_delete_preview';

/** How many names are spelled out before "and N more". */
export const NAMES_SHOWN = 3;

/** What stops a delete: 280's open work, 262's legal hold. */
export interface BlockReasons {
  legalHold: boolean;
  cases: number;
  dealRooms: number;
  submissionGroups: number;
}

export interface BlockedContact extends BlockReasons {
  id: string;
}

const DELETED_KINDS = ['chats', 'tasks', 'dealRooms'] as const;
const KEPT_KINDS = ['deals', 'documents', 'cases'] as const;
export type DeletedKind = (typeof DELETED_KINDS)[number];
export type KeptKind = (typeof KEPT_KINDS)[number];

export type DeletePreview = Record<DeletedKind | KeptKind, number> & {
  blocked: BlockedContact[];
};

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && v > 0 ? v : 0;
}

function openWork(o: Json): Omit<BlockReasons, 'legalHold'> {
  return {
    cases: count(o.cases),
    dealRooms: count(o.deal_rooms),
    submissionGroups: count(o.submission_groups),
  };
}

/** The RPC's answer, or null when it is not one. */
export function parseDeletePreview(data: unknown): DeletePreview | null {
  if (!isObject(data) || !Array.isArray(data.blocked)) return null;
  return {
    chats: count(data.chats),
    tasks: count(data.tasks),
    dealRooms: count(data.deal_rooms),
    deals: count(data.deals),
    documents: count(data.documents),
    cases: count(data.cases),
    blocked: data.blocked.flatMap((b: unknown) =>
      isObject(b) && typeof b.contact_id === 'string'
        ? [
            {
              id: b.contact_id,
              legalHold: b.legal_hold === true,
              ...openWork(b),
            },
          ]
        : []
    ),
  };
}

/** Who a delete may ask for, and who is left out, in the order asked. */
export function splitDeletable(
  ids: readonly string[],
  blocked: readonly BlockedContact[]
): { deletable: string[]; blocked: BlockedContact[] } {
  const byId = new Map(blocked.map((b) => [b.id, b]));
  return {
    deletable: ids.filter((id) => !byId.has(id)),
    blocked: ids.flatMap((id) => byId.get(id) ?? []),
  };
}

/** Why a DELETE was refused; null for any other failure. */
export function deleteRefusal(error: {
  code?: string | null;
  hint?: string | null;
  details?: string | null;
}): BlockReasons | null {
  const none = { cases: 0, dealRooms: 0, submissionGroups: 0 };
  if (error.hint === 'LEGAL_HOLD') return { legalHold: true, ...none };
  if (error.hint !== 'HAS_OPEN_WORK' && error.code !== 'ZC280') return null;
  let work = none;
  try {
    const details: unknown = JSON.parse(error.details ?? '');
    if (isObject(details)) work = openWork(details);
  } catch {
    // No counts: still refused for open work.
  }
  return { legalHold: false, ...work };
}

/** `Contacts.deleteDialog` messages. */
export type DeleteText = (
  key:
    | 'reasonLegalHold'
    | 'reasonCases'
    | 'reasonDealRooms'
    | 'reasonSubmissionGroups'
    | 'reasonOpenWork'
    | 'reasonFailed'
    | 'stayedRow'
    | 'moreNames',
  values?: Record<string, string | number>
) => string;

function list(locale: string, parts: string[]): string {
  return new Intl.ListFormat(locale).format(parts);
}

/** "a legal hold and 2 open cases". */
export function reasonsText(
  r: BlockReasons,
  t: DeleteText,
  locale: string
): string {
  const parts = [
    r.legalHold && t('reasonLegalHold'),
    r.cases > 0 && t('reasonCases', { count: r.cases }),
    r.dealRooms > 0 && t('reasonDealRooms', { count: r.dealRooms }),
    r.submissionGroups > 0 &&
      t('reasonSubmissionGroups', { count: r.submissionGroups }),
  ].filter((p) => p !== false);
  return parts.length > 0 ? list(locale, parts) : t('reasonOpenWork');
}

/** Who stayed after a delete, and why: "Sara (1 open case), and 2 more". */
export function stayedText(
  stayed: {
    refused: readonly BlockedContact[];
    failed: readonly string[];
  },
  nameOf: (id: string) => string,
  t: DeleteText,
  locale: string
): string {
  const rows = [
    ...stayed.refused.map((r) => ({
      id: r.id,
      reason: reasonsText(r, t, locale),
    })),
    ...stayed.failed.map((id) => ({ id, reason: t('reasonFailed') })),
  ];
  const parts = rows
    .slice(0, NAMES_SHOWN)
    .map((r) => t('stayedRow', { name: nameOf(r.id), reason: r.reason }));
  const more = rows.length - parts.length;
  if (more > 0) parts.push(t('moreNames', { count: more }));
  return list(locale, parts);
}

/** `failed` covers a missing function (PGRST202): today's plain question. */
export type PreviewState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; preview: DeletePreview };

export interface DeleteDialogView {
  loading: boolean;
  /** The preview answered, so 280 is there and remembers opt-outs. */
  optOutNote: boolean;
  /** Who Delete asks for. Empty = no Delete button. */
  deletable: string[];
  deleted: { kind: DeletedKind; count: number }[];
  kept: { kind: KeptKind; count: number }[];
  blocked: BlockedContact[];
  /** Blocked ones not in `blocked`. */
  blockedMore: number;
}

export function deleteDialogView(
  ids: readonly string[],
  state: PreviewState
): DeleteDialogView {
  if (state.kind !== 'ready') {
    return {
      loading: state.kind === 'loading',
      optOutNote: false,
      deletable: [...ids],
      deleted: [],
      kept: [],
      blocked: [],
      blockedMore: 0,
    };
  }
  const { preview } = state;
  const { deletable, blocked } = splitDeletable(ids, preview.blocked);
  // Nobody to delete: the counts are the blocked ones' own.
  const counts = <K extends DeletedKind | KeptKind>(kinds: readonly K[]) =>
    deletable.length === 0
      ? []
      : kinds
          .map((kind) => ({ kind, count: preview[kind] }))
          .filter((c) => c.count > 0);
  return {
    loading: false,
    optOutNote: deletable.length > 0,
    deletable,
    deleted: counts(DELETED_KINDS),
    kept: counts(KEPT_KINDS),
    blocked: blocked.slice(0, NAMES_SHOWN),
    blockedMore: Math.max(0, blocked.length - NAMES_SHOWN),
  };
}
