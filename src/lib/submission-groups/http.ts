/**
 * Pure request/response helpers for the internal Submission Groups routes
 * (`/api/submission-groups/[id]/*`): body parsing, the tenancy check, the
 * send rate-limit window, and the mapping of service / SQL errors onto
 * `{ error }` responses. No I/O here; the routes do that.
 */
import { GROUP_SEND_LIMIT } from '@/lib/groups/member-requests';

import { isStaffLabel, type StaffLabel } from './rules';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from './service';
import { SubmissionGroupDbError, type SubmissionGroup } from './store';

export const SG_TEXT_MAX = 4096;

/** A response the route answers as `{ error, ...extra }` with `status`. */
export class SgHttpError extends Error {
  override readonly name = 'SgHttpError';
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }

  get body(): Record<string, unknown> {
    return { error: this.message, ...this.extra };
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const asObject = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

export const GROUP_NOT_FOUND = 'Group not found';

/** The group, only when it exists and belongs to the caller's account; else 404. */
export function ownGroup(
  group: SubmissionGroup | null,
  accountId: string
): SubmissionGroup {
  if (!group || group.accountId !== accountId)
    throw new SgHttpError(404, GROUP_NOT_FOUND);
  return group;
}

/** POST messages: `{ text }`, trimmed, 1–4096 characters. */
export function parseSendText(raw: unknown): { text: string } {
  const value = asObject(raw).text;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new SgHttpError(400, 'text must not be empty');
  if (text.length > SG_TEXT_MAX)
    throw new SgHttpError(
      400,
      `text must be at most ${SG_TEXT_MAX} characters`
    );
  return { text };
}

/** PUT access: `{ user_id, label }`. */
export function parseAccessSet(raw: unknown): {
  userId: string;
  label: StaffLabel;
} {
  const b = asObject(raw);
  if (!isUuid(b.user_id)) throw new SgHttpError(400, 'user_id must be a uuid');
  if (!isStaffLabel(b.label))
    throw new SgHttpError(
      400,
      'label must be one of agent, coordinator, team_lead'
    );
  return { userId: b.user_id, label: b.label };
}

/** DELETE access: `?user_id=`. */
export function parseAccessRemove(params: URLSearchParams): {
  userId: string;
} {
  const userId = params.get('user_id');
  if (!isUuid(userId)) throw new SgHttpError(400, 'user_id must be a uuid');
  return { userId };
}

/** ISO start of the send rate-limit window ending at `now`. */
export function sendWindowStart(now: number = Date.now()): string {
  return new Date(now - GROUP_SEND_LIMIT.windowMs).toISOString();
}

export function isOverSendLimit(count: number | null): boolean {
  return (count ?? 0) >= GROUP_SEND_LIMIT.perWindow;
}

const REFUSAL: Record<
  SubmissionGroupSendRefusedError['reason'],
  [number, string]
> = {
  GROUP_NOT_FOUND: [404, GROUP_NOT_FOUND],
  GROUP_NOT_READY: [409, 'The WhatsApp group is not ready yet'],
  NUMBER_REMOVED: [409, 'The WhatsApp number hosting this group was removed'],
  CONTACT_REMOVED: [409, 'The customer contact of this group was deleted'],
  SEND_NOT_ALLOWED: [403, "You can't send to this group"],
  UNKNOWN_USER: [403, "You can't send to this group"],
};

/**
 * What a failed `sendFromCrm` answers. Anything unclassified is a gateway
 * failure (502): the message row is already settled failed, so the wording
 * stays generic and never echoes the gateway's.
 */
export function sendErrorFor(err: unknown): SgHttpError {
  if (err instanceof SgHttpError) return err;
  if (err instanceof SubmissionGroupSendRefusedError) {
    const [status, message] = REFUSAL[err.reason];
    return new SgHttpError(status, message);
  }
  // WhatsApp already holds the message: a 2xx, so the composer clears the
  // text and nobody is invited to resend it.
  if (err instanceof SubmissionGroupSentNotRecordedError)
    return new SgHttpError(202, 'Sent, but not recorded yet', { sent: true });
  if (err instanceof SubmissionGroupSendBlockedError)
    return new SgHttpError(409, 'Sending to this customer is blocked', {
      reason: err.reason,
    });
  return new SgHttpError(502, 'The message could not be sent');
}

/**
 * What a failed access write answers, or null for an error the caller's
 * generic handler owns (auth errors, unexpected failures → 500).
 */
export function accessErrorFor(err: unknown): SgHttpError | null {
  if (err instanceof SgHttpError) return err;
  if (!(err instanceof SubmissionGroupDbError)) return null;
  switch (err.code) {
    case '55000':
      return new SgHttpError(409, 'This group has ended');
    case 'P0001': // the access trigger's live-staff guard
    case '23514':
    case '23503': // no such user
      return new SgHttpError(422, "That person can't be added");
    case '22P02':
    case '22023':
      return new SgHttpError(400, 'Invalid request');
    default:
      return null;
  }
}
