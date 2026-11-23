/**
 * What the group composer may say about a send, from the route's answer.
 * A send nobody is sure about must not read as "could not send": the
 * group would get it twice.
 */

/** The route's code for "WhatsApp may hold it". */
export const ROOM_SEND_UNCONFIRMED = 'unconfirmed';

/** Refusals with words of their own (`Chat.rooms.composer.errors`). */
const REFUSALS = new Set([
  'window_closed',
  'room_not_open',
  'group_not_ready',
  'group_suspended',
  'template_rejected',
  'forbidden',
  'media_type',
  'media_size',
  'media_name',
  'media_content',
  'media_upload',
]);

/** 5xx the route answers before the send, or for a certain refusal. */
const NOT_SENT = new Set(['media_upload', 'meta_error']);

export type RoomSendOutcome =
  | { kind: 'sent' }
  /** In the group, but the CRM could not record it. */
  | { kind: 'notRecorded' }
  | { kind: 'unconfirmed' }
  | { kind: 'refused'; error: string };

/**
 * `answer` null: the request died in the browser. Every 4xx but 408 is a
 * refusal: the route's own come before the send or name Meta's, and a
 * proxy's means the request never reached the app. Any other failure (a
 * proxy's 502/504 page, a 500) leaves it open.
 */
export function roomSendOutcome(
  answer: { status: number; body: unknown } | null
): RoomSendOutcome {
  if (!answer) return { kind: 'unconfirmed' };
  const body =
    answer.body && typeof answer.body === 'object'
      ? (answer.body as Record<string, unknown>)
      : {};
  const { status } = answer;
  if (status >= 200 && status < 300) {
    return { kind: body.id === null ? 'notRecorded' : 'sent' };
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const refused =
    code !== ROOM_SEND_UNCONFIRMED &&
    ((status >= 400 && status < 500 && status !== 408) || NOT_SENT.has(code));
  if (!refused) return { kind: 'unconfirmed' };
  return { kind: 'refused', error: REFUSALS.has(code) ? code : 'generic' };
}
