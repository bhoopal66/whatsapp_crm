// ============================================================
// POST /api/v1/submission-groups — open the WhatsApp group of a
// submitted case (scope: submission_groups:write). Module 018a.
//
// Idempotent per (account, submission_id): a second call returns the
// existing group (200), finishing its WhatsApp group if that is still
// pending. A new group answers 201. When WhatsApp could not create the
// group yet the row stays pending, the cron retries it, and this answers
// 202 with `whatsapp.pending: true` — never a 5xx for that.
//
// Staff are named by login email: each must be a live agent, team
// leader, admin or owner of the key's workspace (422 unknown_user names
// the field). The group lives on a Whapi number the agent may use.
// A customer WhatsApp refused to add is sent the invite link 1:1; the
// outcome is recorded on the group (migration 118, invite_sent_at).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import { loadChannels } from '@/lib/whatsapp/channels';
import { sendInviteLink } from '@/lib/whatsapp/groups';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';
import {
  chooseHostingNumber,
  inviteCodeOf,
  parseCreateInput,
  phoneWasRefused,
  resolveStaff,
  serializeGroup,
  type AccessEntry,
  type ChannelMemberRow,
  type StaffRow,
} from '@/lib/submission-groups/api-input';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

export const maxDuration = 60;

const CONSENT_MESSAGE =
  'The customer has opted out of WhatsApp messages or asked not to be contacted';
const PENDING_MESSAGE =
  'WhatsApp could not create the group yet; it will be retried automatically';
// The invite's recorded failure (`invite_send_error`), one fixed category:
// every member of the group reads it in the dashboard, so the gateway's own
// error text (which can carry provider detail) stays in the server log.
const INVITE_NO_NUMBER = 'The hosting WhatsApp number is not available';
const INVITE_REFUSED = 'WhatsApp refused the invite';
const INVITE_NOT_SENT = 'The invite could not be sent';

/** A gateway error carries its HTTP `status`: the provider answered and refused. */
function inviteFailure(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? INVITE_REFUSED : INVITE_NOT_SENT;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:write');
    const body = await request.json().catch(() => null);
    const parsed = parseCreateInput(body);
    if (!parsed.ok) return fail('bad_request', parsed.message, 400);
    const input = parsed.value;
    const db = ctx.supabase;
    const store = submissionGroupStore(db);
    const service = submissionGroupService(ctx.accountId, db);

    const respond = async (
      group: SubmissionGroup,
      status: number,
      extras: Parameters<typeof serializeGroup>[2] = {},
      emails: Map<string, string> = new Map()
    ) => {
      const access: AccessEntry[] = (await store.listAccess(group)).map(
        (a) => ({ ...a, email: emails.get(a.userId) })
      );
      return ok(serializeGroup(group, access, extras), status);
    };

    // An existing group is returned as it stands; only its WhatsApp group may still be finished.
    const existing = await store.findByRef(ctx.accountId, input.submissionId);
    let open: Parameters<typeof service.openForSubmission>[0];
    let emails = new Map<string, string>();
    let customerPhone = input.customerPhone;
    if (existing) {
      open = {
        accountId: ctx.accountId,
        submissionRef: existing.submissionRef,
        // Ignored for an existing group (its row is returned as it stands).
        contactId: existing.contactId ?? '',
        channelId: existing.channelId ?? '',
        subject: existing.subject,
        coordinatorPhone: existing.coordinatorPhone,
        access: [],
        keyId: ctx.keyId,
      };
    } else {
      const { data: staffRows, error: staffError } = await db.rpc(
        'sg_staff_by_email',
        {
          p_account: ctx.accountId,
          p_emails: input.staff.map((s) => s.email),
        }
      );
      if (staffError) {
        console.error('[api/v1/submission-groups] staff lookup:', staffError);
        return fail('internal', 'Failed to open the submission group', 500);
      }
      const staff = resolveStaff(input.staff, (staffRows ?? []) as StaffRow[]);
      if (!staff.ok) {
        return staff.code === 'unknown_user'
          ? fail(
              'unknown_user',
              `'${staff.field}' is not an active staff member of this workspace`,
              422
            )
          : fail(
              'duplicate_user',
              `'${staff.fields[0]}' and '${staff.fields[1]}' name the same person`,
              422
            );
      }
      emails = new Map(staff.staff.map((s) => [s.userId, s.email]));
      const agent = staff.staff.find((s) => s.label === 'agent')!;

      // The number first: a refused call must not leave a new contact behind.
      const channels = await loadChannels(db, ctx.accountId);
      const whapiIds = channels
        .filter((c) => c.provider === 'whapi')
        .map((c) => c.id);
      let members: ChannelMemberRow[] = [];
      if (whapiIds.length > 0) {
        const { data, error } = await db
          .from('whatsapp_channel_members')
          .select('config_id, user_id')
          .eq('account_id', ctx.accountId)
          .in('config_id', whapiIds);
        if (error) {
          console.error('[api/v1/submission-groups] allocations:', error);
          return fail('internal', 'Failed to open the submission group', 500);
        }
        members = (data ?? []) as ChannelMemberRow[];
      }
      const hosting = chooseHostingNumber({
        channels,
        members,
        agentUserId: agent.userId,
        agentRole: agent.role,
        requestedId: input.channelId,
      });
      if (!hosting.ok) {
        return hosting.code === 'no_whapi_number'
          ? fail(
              'no_whapi_number',
              'No Whapi WhatsApp number is connected to this workspace',
              422
            )
          : fail(
              'channel_not_allowed',
              'The agent may not use this WhatsApp number',
              422
            );
      }

      const auditUserId = await resolveAuditUserId(db, ctx.accountId);
      const contact = await findOrCreateContact(
        db,
        ctx.accountId,
        auditUserId,
        {
          phone: input.customerPhone,
          name: input.customerName ?? undefined,
        }
      );

      const consent = await store.contactConsent(contact.id);
      if (consent.reason === 'opted_out' || consent.reason === 'do_not_contact')
        return fail('consent_required', CONSENT_MESSAGE, 409);
      customerPhone = consent.phone ?? input.customerPhone;

      open = {
        accountId: ctx.accountId,
        submissionRef: input.submissionId,
        contactId: contact.id,
        channelId: hosting.channel.id,
        subject: input.subject,
        coordinatorPhone: input.coordinatorPhone,
        access: staff.staff.map((s) => ({ userId: s.userId, label: s.label })),
        keyId: ctx.keyId,
      };
    }

    let result: Awaited<ReturnType<typeof service.openForSubmission>>;
    try {
      result = await service.openForSubmission(open);
    } catch (err) {
      // The row may exist with its WhatsApp group still pending (a gateway failure): the cron retries it.
      const pending = await store
        .findByRef(ctx.accountId, open.submissionRef)
        .catch(() => null);
      if (!pending) throw err;
      console.error('[api/v1/submission-groups] create pending:', err);
      return respond(pending, 202, { error: PENDING_MESSAGE }, emails);
    }
    if (result.consentRequired)
      return fail('consent_required', CONSENT_MESSAGE, 409);

    let group = result.group;
    let inviteSent = false;
    const code = inviteCodeOf(result.inviteLink);
    if (code && phoneWasRefused(result.refusedParticipants, customerPhone)) {
      let sendError: string | null = INVITE_NO_NUMBER;
      try {
        const channel = (await loadChannels(db, ctx.accountId)).find(
          (c) => c.id === group.channelId
        );
        if (channel) {
          await sendInviteLink({
            channel,
            inviteCode: code,
            to: customerPhone,
          });
          inviteSent = true;
          sendError = null;
        }
      } catch (err) {
        console.error('[api/v1/submission-groups] invite send:', err);
        sendError = inviteFailure(err);
      }
      // Best-effort: the send already happened (or not); recording it never fails the request.
      try {
        if (await store.noteInvite(group.id, inviteSent, sendError))
          group = (await store.get(group.id)) ?? group;
      } catch (err) {
        console.error('[api/v1/submission-groups] invite record:', err);
      }
    }

    const extras = {
      refusedParticipants: result.refusedParticipants,
      inviteSent,
    };
    if (group.waGroupId === null && group.status === 'ACTIVE')
      return respond(group, 202, { ...extras, error: PENDING_MESSAGE }, emails);
    return respond(group, result.created ? 201 : 200, extras, emails);
  } catch (err) {
    if (err instanceof ContactError) {
      return err.status === 400
        ? fail('bad_request', err.message, 400)
        : fail('internal', 'Failed to open the submission group', 500);
    }
    return toApiErrorResponse(err);
  }
}
