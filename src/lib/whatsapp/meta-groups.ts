/**
 * Meta Cloud API — Groups API client (deal rooms, module 014c).
 *
 * A deal room is a real WhatsApp group on the account's Meta number.
 * Same conventions as `meta-api.ts`, whose fetch wrapper and error
 * class this reuses: one options object per call, `Authorization:
 * Bearer`, every failure a `MetaError` (the group codes have their own
 * capability getters there: `isGroupNotReady`, `isGroupSuspended`, …).
 *
 * Things Meta's reference says that shape this module:
 *  - Create is ASYNCHRONOUS. The group id and the invite link arrive
 *    only in the `group_lifecycle_update` webhook (`group_create`),
 *    correlated by `request_id`. The synchronous response body is not
 *    documented, so `createGroup` keeps whatever id it carries and
 *    tolerates anything (`requestId` may be null).
 *  - A group can be written to only once a participant joined (#131020).
 *  - Reject-join-request and remove-participants are DELETEs with a
 *    JSON body.
 *  - Group ids are opaque strings: stored as text, never parsed.
 */

import {
  META_API_BASE,
  MetaError,
  metaFetch,
  throwMetaError,
  type MediaKind,
  type MetaSendResult,
} from './meta-api';

/** Meta's documented ceilings. */
export const GROUP_SUBJECT_MAX = 128;
export const GROUP_DESCRIPTION_MAX = 2048;
export const GROUP_MAX_PARTICIPANTS = 8;

export type JoinApprovalMode = 'approval_required' | 'auto_approve';

interface GroupAuth {
  groupId: string;
  accessToken: string;
}

interface NumberAuth {
  phoneNumberId: string;
  accessToken: string;
}

function groupUrl(groupId: string, suffix = ''): string {
  return `${META_API_BASE}/${encodeURIComponent(groupId)}${suffix}`;
}

/** One JSON call; throws `MetaError` on a non-2xx, returns the parsed body. */
async function call(
  url: string,
  accessToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await metaFetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  // Several of these calls have no documented response body; an empty
  // or non-JSON 2xx is a success with nothing to read.
  try {
    const data: unknown = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function firstMessageId(data: Record<string, unknown>): string {
  const messages = data.messages;
  const id = Array.isArray(messages)
    ? str((messages[0] as { id?: unknown } | undefined)?.id)
    : null;
  if (!id) throw new MetaError('Meta returned no message id', 502);
  return id;
}

// ============================================================
// Lifecycle
// ============================================================

export interface CreateGroupArgs extends NumberAuth {
  subject: string;
  description?: string | null;
  /** Meta's default is `auto_approve`; deal rooms ask for approval. */
  joinApprovalMode?: JoinApprovalMode;
}

export interface CreateGroupResult {
  /**
   * The id to match the `group_create` webhook on, when the synchronous
   * response carries one (`request_id`, else `id`). UNVERIFIED: Meta
   * documents no response body for this call, so null is possible and
   * the caller must still be able to finish the room from the webhook.
   */
  requestId: string | null;
}

export async function createGroup(
  args: CreateGroupArgs
): Promise<CreateGroupResult> {
  const subject = args.subject.trim();
  if (!subject || subject.length > GROUP_SUBJECT_MAX) {
    throw new Error(
      `A group subject must be 1 to ${GROUP_SUBJECT_MAX} characters.`
    );
  }
  const description = args.description?.trim() || null;
  if (description && description.length > GROUP_DESCRIPTION_MAX) {
    throw new Error(
      `A group description must be at most ${GROUP_DESCRIPTION_MAX} characters.`
    );
  }
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    subject,
  };
  if (description) body.description = description;
  if (args.joinApprovalMode) body.join_approval_mode = args.joinApprovalMode;

  const data = await call(
    `${META_API_BASE}/${args.phoneNumberId}/groups`,
    args.accessToken,
    'POST',
    body
  );
  return { requestId: str(data.request_id) ?? str(data.id) };
}

export interface GroupInfo {
  id: string;
  subject: string | null;
  description: string | null;
  joinApprovalMode: JoinApprovalMode | null;
  suspended: boolean;
  /** Unix seconds. */
  createdAt: number | null;
  /** Excludes our own number (Meta). */
  participantCount: number | null;
  participants: string[];
}

const GROUP_INFO_FIELDS =
  'subject,description,participants,join_approval_mode,suspended,creation_timestamp,total_participant_count';

export async function getGroupInfo(args: GroupAuth): Promise<GroupInfo> {
  const data = await call(
    `${groupUrl(args.groupId)}?fields=${GROUP_INFO_FIELDS}`,
    args.accessToken,
    'GET'
  );
  const mode = data.join_approval_mode;
  const created = Number(data.creation_timestamp);
  const count = Number(data.total_participant_count);
  const participants = Array.isArray(data.participants)
    ? data.participants
        .map((p) => str((p as { wa_id?: unknown } | null)?.wa_id))
        .filter((id): id is string => id !== null)
    : [];
  return {
    id: str(data.id) ?? args.groupId,
    subject: str(data.subject),
    description: str(data.description),
    joinApprovalMode:
      mode === 'approval_required' || mode === 'auto_approve' ? mode : null,
    suspended: data.suspended === true,
    createdAt:
      data.creation_timestamp != null && Number.isFinite(created)
        ? created
        : null,
    participantCount:
      data.total_participant_count != null && Number.isFinite(count)
        ? count
        : null,
    participants,
  };
}

/**
 * Deletes the group and removes everyone in it, our number included.
 * The outcome is confirmed by the `group_delete` webhook.
 */
export async function deleteGroup(args: GroupAuth): Promise<void> {
  await call(groupUrl(args.groupId), args.accessToken, 'DELETE');
}

// ============================================================
// Invite link
// ============================================================

function inviteLinkOf(data: Record<string, unknown>): string {
  const link = str(data.invite_link);
  if (!link) throw new MetaError('Meta returned no invite link', 502);
  return link;
}

export async function getInviteLink(
  args: GroupAuth
): Promise<{ inviteLink: string }> {
  const data = await call(
    groupUrl(args.groupId, '/invite_link'),
    args.accessToken,
    'GET'
  );
  return { inviteLink: inviteLinkOf(data) };
}

/** A new link; every earlier link stops working. */
export async function resetInviteLink(
  args: GroupAuth
): Promise<{ inviteLink: string }> {
  const data = await call(
    groupUrl(args.groupId, '/invite_link'),
    args.accessToken,
    'POST',
    { messaging_product: 'whatsapp' }
  );
  return { inviteLink: inviteLinkOf(data) };
}

export interface SendGroupInviteTemplateArgs extends NumberAuth {
  /** The invitee's phone number or wa_id: a normal 1:1 send. */
  to: string;
  /** An unedited Template Library copy (topic `group_invite_link`). */
  templateName: string;
  language: string;
  groupId: string;
}

/**
 * The invite: a 1:1 template whose body parameter of type `group_id`
 * Meta replaces with the group's invite link at delivery.
 */
export async function sendGroupInviteTemplate(
  args: SendGroupInviteTemplateArgs
): Promise<MetaSendResult> {
  const data = await call(
    `${META_API_BASE}/${args.phoneNumberId}/messages`,
    args.accessToken,
    'POST',
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.to,
      type: 'template',
      template: {
        name: args.templateName,
        language: { code: args.language },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'group_id', group_id: args.groupId }],
          },
        ],
      },
    }
  );
  return { messageId: firstMessageId(data) };
}

// ============================================================
// Join requests and participants
// ============================================================

export interface JoinRequest {
  joinRequestId: string;
  waId: string;
  /** Unix seconds (Meta's sample quotes it, the table says integer). */
  createdAt: number | null;
}

export async function listJoinRequests(
  args: GroupAuth & { after?: string }
): Promise<{ requests: JoinRequest[]; nextCursor: string | null }> {
  const query = args.after ? `?after=${encodeURIComponent(args.after)}` : '';
  const data = await call(
    groupUrl(args.groupId, `/join_requests${query}`),
    args.accessToken,
    'GET'
  );
  const requests: JoinRequest[] = [];
  for (const item of Array.isArray(data.data) ? data.data : []) {
    const row = (item ?? {}) as Record<string, unknown>;
    const joinRequestId = str(row.join_request_id);
    const waId = str(row.wa_id);
    if (!joinRequestId || !waId) continue;
    const created = Number(row.creation_timestamp);
    requests.push({
      joinRequestId,
      waId,
      createdAt:
        row.creation_timestamp != null && Number.isFinite(created)
          ? created
          : null,
    });
  }
  const paging = data.paging as
    { cursors?: { after?: unknown }; next?: unknown } | undefined;
  // Graph omits `next` on the last page; a bare `after` cursor alone
  // does not mean there is more.
  const nextCursor = paging?.next ? str(paging.cursors?.after) : null;
  return { requests, nextCursor };
}

export interface JoinRequestFailure {
  joinRequestId: string;
  code: number | null;
  message: string | null;
}

export interface JoinRequestDecisionResult {
  /** Ids Meta acted on. */
  done: string[];
  /** Per-item failures (HTTP 206 / #131201 partial success included). */
  failed: JoinRequestFailure[];
}

function decisionResult(
  data: Record<string, unknown>,
  doneKey: string
): JoinRequestDecisionResult {
  const done = (Array.isArray(data[doneKey]) ? data[doneKey] : [])
    .map(str)
    .filter((id): id is string => id !== null);
  const failed: JoinRequestFailure[] = [];
  const rawFailed = data.failed_join_requests;
  for (const item of Array.isArray(rawFailed) ? rawFailed : []) {
    const row = (item ?? {}) as {
      join_request_id?: unknown;
      errors?: Array<{ code?: unknown; message?: unknown }>;
    };
    const joinRequestId = str(row.join_request_id);
    if (!joinRequestId) continue;
    const first = Array.isArray(row.errors) ? row.errors[0] : undefined;
    const code = Number(first?.code);
    failed.push({
      joinRequestId,
      code: first?.code != null && Number.isFinite(code) ? code : null,
      message: str(first?.message),
    });
  }
  return { done, failed };
}

function joinRequestBody(ids: string[]): Record<string, unknown> {
  if (ids.length === 0) throw new Error('No join requests given.');
  return { messaging_product: 'whatsapp', join_requests: ids };
}

export async function approveJoinRequests(
  args: GroupAuth & { joinRequestIds: string[] }
): Promise<JoinRequestDecisionResult> {
  const data = await call(
    groupUrl(args.groupId, '/join_requests'),
    args.accessToken,
    'POST',
    joinRequestBody(args.joinRequestIds)
  );
  return decisionResult(data, 'approved_join_requests');
}

/** No webhook follows a rejection; the person may ask again. */
export async function rejectJoinRequests(
  args: GroupAuth & { joinRequestIds: string[] }
): Promise<JoinRequestDecisionResult> {
  const data = await call(
    groupUrl(args.groupId, '/join_requests'),
    args.accessToken,
    'DELETE',
    joinRequestBody(args.joinRequestIds)
  );
  return decisionResult(data, 'rejected_join_requests');
}

/**
 * Remove people (phone numbers or wa_ids, 1 to 8). A removed person
 * cannot rejoin through the invite link. The outcome arrives as the
 * `group_participants_remove` webhook; the synchronous body is not
 * documented and is not read.
 */
export async function removeParticipants(
  args: GroupAuth & { participants: string[] }
): Promise<void> {
  const users = [...new Set(args.participants.filter(Boolean))];
  if (users.length === 0 || users.length > GROUP_MAX_PARTICIPANTS) {
    throw new Error(
      `Remove 1 to ${GROUP_MAX_PARTICIPANTS} participants at a time.`
    );
  }
  await call(
    groupUrl(args.groupId, '/participants'),
    args.accessToken,
    'DELETE',
    {
      messaging_product: 'whatsapp',
      participants: users.map((user) => ({ user })),
    }
  );
}

// ============================================================
// Sending to a group
// ============================================================

interface GroupSendArgs extends NumberAuth {
  groupId: string;
  /** Quote this group message (its wamid). */
  contextMessageId?: string;
}

async function sendToGroup(
  args: GroupSendArgs,
  type: string,
  content: Record<string, unknown>
): Promise<MetaSendResult> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'group',
    to: args.groupId,
    type,
    [type]: content,
  };
  if (args.contextMessageId) {
    body.context = { message_id: args.contextMessageId };
  }
  const data = await call(
    `${META_API_BASE}/${args.phoneNumberId}/messages`,
    args.accessToken,
    'POST',
    body
  );
  return { messageId: firstMessageId(data) };
}

export async function sendGroupText(
  args: GroupSendArgs & { text: string }
): Promise<MetaSendResult> {
  return sendToGroup(args, 'text', { body: args.text });
}

/**
 * UNVERIFIED shape: Meta shows no group media example; this is the 1:1
 * payload with `recipient_type: 'group'`, as its prose implies.
 */
export async function sendGroupMedia(
  args: GroupSendArgs & {
    kind: MediaKind;
    link: string;
    caption?: string;
    filename?: string;
  }
): Promise<MetaSendResult> {
  if (!args.link) throw new Error('sendGroupMedia requires a link.');
  const media: Record<string, unknown> = { link: args.link };
  if (args.caption && args.kind !== 'audio') media.caption = args.caption;
  if (args.kind === 'document' && args.filename) media.filename = args.filename;
  return sendToGroup(args, args.kind, media);
}

/**
 * Text- or media-based templates only: groups refuse interactive
 * messages, and whether template buttons work is UNVERIFIED.
 */
export async function sendGroupTemplate(
  args: GroupSendArgs & {
    templateName: string;
    language: string;
    components?: unknown[];
  }
): Promise<MetaSendResult> {
  const template: Record<string, unknown> = {
    name: args.templateName,
    language: { code: args.language },
  };
  if (args.components && args.components.length > 0) {
    template.components = args.components;
  }
  return sendToGroup(args, 'template', template);
}
