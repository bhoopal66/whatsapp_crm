/**
 * Submission Group service (module 018a, migration 115): ties the store to the
 * WhatsApp Groups API (Whapi, `whapi-groups-api.ts`) and the consent check.
 * A group is hosted by ONE Whapi number (`channelId`, frozen); every staff
 * message goes out from it, prefixed `Name (Label): text`.
 *
 *   openForSubmission — DB group (idempotent per submission ref), then
 *     createGroup on the hosting number, then the WhatsApp group id is saved
 *     once. A failed createGroup leaves the group ACTIVE with no WhatsApp
 *     group id ("pending"); the next call (or `retryPending` from the cron)
 *     finishes it, so there is never a second group. Before the gateway is
 *     called the pending row is claimed (sg_claim_create, a lease judged by the
 *     DB clock or deps.now): only the claim holder calls createGroup
 *     (idempotency key = the group row id); anyone else returns the pending
 *     group. A failed createGroup releases the claim, recording the error. A
 *     WhatsApp group that cannot be saved (claim lost, DB error) is closed again
 *     only if the re-read row shows it cannot be live. Before every createGroup
 *     the claim holder re-checks consent (deps.consent: opt-out, do-not-contact,
 *     phone on record — never the caller's phone).
 *     Every create (first call, repeat call, cron, admin retry) ends here, so
 *     this is the one place a customer WhatsApp refused is sent the invite link
 *     1:1: best-effort, the outcome recorded by sg_note_invite, never failing
 *     the create. Consent was checked just before the createGroup.
 *   sendFromCrm — sg_send_begin writes the 'out' row as 'pending' (SQL decides
 *     who may send); then the consent check (refused: row 'blocked'), the send
 *     from the hosting number (error: row 'failed'), and the row is settled
 *     'sent'. Nothing is sent without a stored row, and nothing goes out once the
 *     group is ENDED (sg_end waits for a begin in flight).
 *   endIfDue — shouldEnd → sg_end (ENDED at once) → closeGroup, but only once
 *     the group has no pending 'out' row; otherwise closeDeferred. A deferred or
 *     failed close is retried by the next call.
 *   A `waMode: 'none'` group (136) is the CRM record of a submission with no
 *   WhatsApp group: opened with no number and no consent check (nothing is
 *   sent to the customer), never created, claimed, invited or closed; a send
 *   is refused NO_WHATSAPP_GROUP before anything is stored; sg_end still ends
 *   it.
 *   sweepStalePending — pending 'out' rows older than olderThanMs → failed.
 *   viewArchive — sg_read_archive: the role is decided in SQL from the user id;
 *     audit row and read in one statement.
 */
import { noteCreatedMembership } from './membership';
import {
  assertWindowDays,
  DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS,
  INVITE_RESEND_COOLDOWN_MS,
  inviteCodeOf,
  phoneWasRefused,
  prefixMessage,
  shouldEnd,
  welcomeMessage,
  type StaffLabel,
} from './rules';
import type {
  ArchiveResult,
  ConsentAnswer,
  SubmissionGroup,
  SendStatus,
  SubmissionGroupStore,
  SystemKind,
  SystemSendRefusal,
  WaMode,
} from './store';

/** Boundary to the WhatsApp Groups API (Whapi adapter in whapi-groups-api.ts). */
export interface GroupsApi {
  /**
   * `participants` are phone digits (customer first, then the optional
   * coordinator phone and the bank's coordinators' numbers). `idempotencyKey` is the submission group row id.
   */
  createGroup(
    channelId: string,
    participants: string[],
    subject: string,
    idempotencyKey: string
  ): Promise<{
    waGroupId: string;
    inviteLink: string | null;
    /** Participants WhatsApp refused to add; the group exists regardless. */
    refused?: string[];
  }>;
  sendGroupText(
    channelId: string,
    waGroupId: string,
    text: string
  ): Promise<{ waMessageId: string }>;
  closeGroup(channelId: string, waGroupId: string): Promise<void>;
  /** Sends the group's invite link 1:1 to `to` from the hosting number. */
  sendInvite(channelId: string, inviteCode: string, to: string): Promise<void>;
  /** The group's current invite link, from the gateway. */
  getInviteLink(channelId: string, waGroupId: string): Promise<string>;
}

export type GroupStore = Pick<
  SubmissionGroupStore,
  | 'noteCustomerMembership'
  | 'open'
  | 'get'
  | 'findByRef'
  | 'listPendingCreates'
  | 'openAccessLabel'
  | 'claimCreate'
  | 'releaseCreateClaim'
  | 'attachWaGroup'
  | 'beginSend'
  | 'beginSystemSend'
  | 'settleSend'
  | 'sendState'
  | 'end'
  | 'markWaClosed'
  | 'noteInvite'
  | 'claimInvite'
  | 'recordWaCloseError'
  | 'countPendingOut'
  | 'closeHoldUntil'
  | 'failStalePending'
  | 'readArchive'
>;

/** Why a Resend invite was not attempted; the route words each one. */
export type ResendInviteRefusal =
  | 'not_active'
  | 'no_whatsapp'
  | 'no_group_yet'
  | 'detached'
  | 'opted_out'
  | 'do_not_contact'
  | 'no_phone'
  | 'already_joined'
  | 'too_soon';

export type ResendInviteResult =
  | { status: 'sent'; group: SubmissionGroup }
  | { status: 'refused'; code: ResendInviteRefusal }
  | { status: 'failed'; reason: string };

export interface SubmissionGroupServiceDeps {
  store: GroupStore;
  api: GroupsApi;
  /** Opt-out / do-not-contact / phone of a contact (store.contactConsent). */
  consent: (contactId: string) => Promise<ConsentAnswer>;
  /** profiles.full_name of the user in the group's account (store.displayName). */
  displayName: (userId: string, accountId: string) => Promise<string | null>;
  /** 170: the case's product and bank name for the welcome message. */
  welcomeDetails?: (
    groupId: string
  ) => Promise<{ product: string | null; bankName: string | null } | null>;
  /** Lease on a pending group's WhatsApp group creation (default 120000 ms). */
  createLeaseMs?: number;
  /** Clock for the create lease and the archive window; absent = the DB clock. */
  now?: () => Date;
  /** Days after the end the group's team_lead / coordinator may still read it. */
  archiveSupervisorWindowDays?: number;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export const STAFF_LABEL_TEXT: Record<StaffLabel, string> = {
  agent: 'Agent',
  coordinator: 'Coordinator',
  team_lead: 'Team Lead',
};

export type GroupRefusal =
  | 'GROUP_NOT_FOUND'
  | 'GROUP_NOT_READY'
  /** 136: a submission recorded without a WhatsApp group; nothing can be sent. */
  | 'NO_WHATSAPP_GROUP'
  | 'NUMBER_REMOVED'
  | 'CONTACT_REMOVED'
  | 'SEND_NOT_ALLOWED'
  | 'UNKNOWN_USER';

/** sendFromCrm refused before anything was stored or sent. */
export class SubmissionGroupSendRefusedError extends Error {
  override readonly name = 'SubmissionGroupSendRefusedError';
  constructor(readonly reason: GroupRefusal) {
    super(`submission group send refused: ${reason}`);
  }
}

/** The group's number is gone from the account (or never belonged to it). */
export class SubmissionGroupChannelError extends Error {
  override readonly name = 'SubmissionGroupChannelError';
  constructor(readonly channelId: string) {
    super(`WhatsApp number ${channelId} is not connected to this account`);
  }
}

/** The consent check refused a send; the row was settled 'blocked'. */
export class SubmissionGroupSendBlockedError extends Error {
  override readonly name = 'SubmissionGroupSendBlockedError';
  constructor(readonly reason: 'opted_out' | 'do_not_contact') {
    super(`submission group send blocked: ${reason}`);
  }
}

/**
 * The gateway accepted the message but its row could not be settled 'sent'
 * (the settle threw, twice). WhatsApp holds the message: callers must not
 * invite a resend. The row stays pending until something settles it.
 */
export class SubmissionGroupSentNotRecordedError extends Error {
  override readonly name = 'SubmissionGroupSentNotRecordedError';
  constructor(
    readonly messageId: string,
    readonly waMessageId: string,
    cause: unknown
  ) {
    super(
      `submission group message ${messageId} (${waMessageId}) was sent but could not be recorded`,
      { cause }
    );
  }
}

export type OpenResult =
  | { consentRequired: true; group: null; inviteLink: null }
  | {
      consentRequired: false;
      created: boolean;
      group: SubmissionGroup;
      inviteLink: string | null;
      refusedParticipants: string[];
      /** This call sent the customer the invite link 1:1. */
      inviteSent: boolean;
    };

/** closeDeferred: ENDED, but closeGroup waits for a pending send or 170's close hold; the next call retries. */
export type EndResult = {
  ended: boolean;
  reason: string | null;
  closed: boolean;
  closeError: string | null;
  closeDeferred: boolean;
};

/**
 * sendSystem's outcome. `duplicate`: a row with this key already exists
 * (its own state in `sendStatus`); nothing new was stored or sent.
 * `refused`: sg_send_begin_system stored nothing. `blocked`: the consent
 * check refused and the row was settled 'blocked'.
 */
export type SystemSendResult =
  | { status: 'sent'; messageId: string; waMessageId: string }
  | { status: 'duplicate'; messageId: string; sendStatus: SendStatus | null }
  | { status: 'refused'; code: SystemSendRefusal }
  | { status: 'blocked'; reason: 'opted_out' | 'do_not_contact' };

type CreateOutcome =
  | { consentRequired: true }
  | {
      consentRequired: false;
      group: SubmissionGroup;
      inviteLink: string | null;
      refused: string[];
      inviteSent: boolean;
    };

export const DEFAULT_CREATE_LEASE_MS = 120_000;

// The invite's recorded failure (`invite_send_error`), one fixed category:
// every member of the group reads it in the dashboard, so the gateway's own
// error text (which can carry provider detail) stays in the server log.
const INVITE_NO_NUMBER = 'The hosting WhatsApp number is not available';
const INVITE_NO_LINK = 'The group has no invite link';
const INVITE_NOT_ALLOWED = 'The customer can no longer be contacted';
const INVITE_REFUSED = 'WhatsApp refused the invite';
const INVITE_NOT_SENT = 'The invite could not be sent';

/** A gateway error carries its HTTP `status`: the provider answered and refused. */
function inviteFailure(err: unknown): string {
  if (err instanceof SubmissionGroupChannelError) return INVITE_NO_NUMBER;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? INVITE_REFUSED : INVITE_NOT_SENT;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CONSENT_REQUIRED = {
  consentRequired: true,
  group: null,
  inviteLink: null,
} as const;

export class SubmissionGroupService {
  constructor(private readonly deps: SubmissionGroupServiceDeps) {
    assertWindowDays(
      deps.archiveSupervisorWindowDays ?? DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS
    );
  }

  private get log() {
    return this.deps.logger ?? console;
  }

  async openForSubmission(input: {
    accountId: string;
    submissionRef: string;
    contactId: string;
    /** NULL with `waMode: 'none'` (136): no hosting number. */
    channelId: string | null;
    /** 136: 'none' opens only the CRM record; default 'group'. Ignored for an existing group. */
    waMode?: WaMode;
    subject: string;
    coordinatorPhone: string | null;
    /** 142: the bank's coordinators' numbers (digits), added to the WhatsApp group too. */
    coordinatorPhones?: readonly string[];
    access: readonly { userId: string; label: StaffLabel }[];
    keyId: string | null;
    /** 141: stored on a new group as its customer name. Ignored for an existing group. */
    customerName: string | null;
  }): Promise<OpenResult> {
    const { store } = this.deps;
    // An existing group is returned as it stands (its number, mode and list never change here).
    let group = await store.findByRef(input.accountId, input.submissionRef);
    let created = false;
    if (!group) {
      // No row for a customer we may not message. A 'none' row messages nobody (136).
      if (
        input.waMode !== 'none' &&
        !(await this.deps.consent(input.contactId)).allowed
      )
        return CONSENT_REQUIRED;
      const r = await store.open(input);
      created = r.created;
      group = await store.get(r.groupId);
      if (!group) throw new Error(`submission group ${r.groupId} vanished`);
    }
    // Already complete, ENDED before its WhatsApp group existed, or never to have one (136): nothing to create.
    if (
      group.waMode === 'none' ||
      group.waGroupId !== null ||
      group.status !== 'ACTIVE'
    )
      return {
        consentRequired: false,
        created,
        group,
        inviteLink: group.inviteLink,
        refusedParticipants: [],
        inviteSent: false,
      };
    const out = await this.createPending(group);
    if (out.consentRequired) return CONSENT_REQUIRED;
    return {
      consentRequired: false,
      created,
      group: out.group,
      inviteLink: out.inviteLink,
      refusedParticipants: out.refused,
      inviteSent: out.inviteSent,
    };
  }

  /**
   * Cron: finishes ACTIVE groups still without a WhatsApp group and older than
   * `olderThanMs` through the same claim/create path. One group's failure is
   * reported, never thrown, so the rest still run.
   */
  async retryPending(input: {
    accountId: string;
    olderThanMs: number;
  }): Promise<{
    attempted: number;
    created: string[];
    consentRequired: string[];
    failed: { groupId: string; error: string }[];
  }> {
    const now = this.deps.now?.() ?? new Date();
    // Only this account's rows: the Whapi adapter behind deps.api loads one account's numbers.
    const pending = await this.deps.store.listPendingCreates(
      new Date(now.getTime() - input.olderThanMs),
      { accountId: input.accountId }
    );
    const result = {
      attempted: pending.length,
      created: [] as string[],
      consentRequired: [] as string[],
      failed: [] as { groupId: string; error: string }[],
    };
    for (const g of pending) {
      try {
        const out = await this.createPending(g);
        if (out.consentRequired) result.consentRequired.push(g.id);
        else if (out.group.waGroupId !== null) result.created.push(g.id);
      } catch (err) {
        result.failed.push({ groupId: g.id, error: errText(err) });
      }
    }
    return result;
  }

  /**
   * Finishes one pending create now (the admin "retry" action) through the same claim/create path. A group that
   * already has its WhatsApp group, or has ENDED, is returned as it stands with no gateway call.
   */
  async retryOne(groupId: string): Promise<OpenResult> {
    const group = await this.deps.store.get(groupId);
    if (!group) throw new Error(`submission group ${groupId} not found`);
    if (
      group.waMode === 'none' ||
      group.waGroupId !== null ||
      group.status !== 'ACTIVE'
    )
      return {
        consentRequired: false,
        created: false,
        group,
        inviteLink: group.inviteLink,
        refusedParticipants: [],
        inviteSent: false,
      };
    const out = await this.createPending(group);
    if (out.consentRequired) return CONSENT_REQUIRED;
    return {
      consentRequired: false,
      created: false,
      group: out.group,
      inviteLink: out.inviteLink,
      refusedParticipants: out.refused,
      inviteSent: out.inviteSent,
    };
  }

  /** The claim / consent re-check / create / attach path for one pending group. */
  private async createPending(group: SubmissionGroup): Promise<CreateOutcome> {
    const { store, api } = this.deps;
    // Number or contact deleted (115 detaches the group): nothing to create on, nobody to add.
    const { channelId, contactId } = group;
    if (channelId === null || contactId === null)
      return {
        consentRequired: false,
        group,
        inviteLink: group.inviteLink,
        refused: [],
        inviteSent: false,
      };
    // Only the holder of the create claim calls the gateway; anyone else gets the group as it stands.
    const token = await store.claimCreate(
      group.id,
      this.deps.createLeaseMs ?? DEFAULT_CREATE_LEASE_MS,
      this.deps.now?.()
    );
    if (token === null) {
      const current = await store.get(group.id);
      return {
        consentRequired: false,
        group: current ?? group,
        inviteLink: current?.inviteLink ?? null,
        refused: [],
        inviteSent: false,
      };
    }
    let made: Awaited<ReturnType<GroupsApi['createGroup']>>;
    let customerPhone: string;
    try {
      // Re-checked by the claim holder before every createGroup: a pending group's row says nothing about consent now.
      const consent = await this.deps.consent(contactId);
      if (!consent.allowed || !consent.phone) {
        await this.releaseClaimQuietly(group.id, token, null);
        return { consentRequired: true };
      }
      // The customer, then the coordinator numbers. A 142 row's list is already deduped, capped and holds the
      // request's number; only an older row falls back to its single coordinator_phone. Compared as digits.
      customerPhone = consent.phone;
      const participants = [consent.phone];
      const seen = [consent.phone.replace(/\D/g, '')];
      const coordinators = group.coordinatorPhones?.length
        ? group.coordinatorPhones
        : [group.coordinatorPhone];
      for (const p of coordinators) {
        const d = (p ?? '').replace(/\D/g, '');
        if (d === '' || seen.includes(d)) continue;
        seen.push(d);
        participants.push(p!);
      }
      made = await api.createGroup(
        channelId,
        participants,
        group.subject,
        group.id
      );
    } catch (err) {
      await this.releaseClaimQuietly(group.id, token, errText(err));
      throw err;
    }
    let attached: boolean;
    try {
      attached = await store.attachWaGroup(
        group.id,
        made.waGroupId,
        made.inviteLink,
        token
      );
    } catch (err) {
      await this.discardIfOrphan(group, made.waGroupId, err);
      throw err;
    }
    if (!attached) {
      // Our claim expired and another caller took it (or the group ended). Whapi has no idempotency key, so the
      // group we got back is ours alone unless the row stores its id: otherwise close it (the cron recreates).
      const current = await this.discardIfOrphan(
        group,
        made.waGroupId,
        'create claim lost'
      );
      return {
        consentRequired: false,
        group: current ?? group,
        inviteLink: current?.inviteLink ?? null,
        refused: [],
        inviteSent: false,
      };
    }
    const live: SubmissionGroup = {
      ...group,
      waGroupId: made.waGroupId,
      inviteLink: made.inviteLink,
      waCreateError: null,
    };
    const refused = made.refused ?? [];
    const invite = phoneWasRefused(refused, customerPhone)
      ? await this.inviteCustomer(live, channelId, customerPhone)
      : { group: live, sent: false };
    await noteCreatedMembership(store, group.id, customerPhone, refused);
    return {
      consentRequired: false,
      group: invite.group,
      inviteLink: made.inviteLink,
      refused,
      inviteSent: invite.sent,
    };
  }

  /** Sends a refused customer the group's invite link and records the outcome. Never throws. */
  private async inviteCustomer(
    group: SubmissionGroup,
    channelId: string,
    phone: string
  ): Promise<{ group: SubmissionGroup; sent: boolean }> {
    const code = inviteCodeOf(group.inviteLink);
    let sent = false;
    let error: string | null = INVITE_NO_LINK;
    if (code) {
      try {
        // Consent was judged before createGroup; the customer may have opted out since.
        let allowed = false;
        try {
          if (group.contactId)
            allowed = (await this.deps.consent(group.contactId)).allowed;
        } catch (err) {
          this.log.warn('invite consent could not be re-read', {
            groupId: group.id,
            err: errText(err),
          });
        }
        if (!allowed) {
          error = INVITE_NOT_ALLOWED;
          return {
            group: await this.recordInvite(group, false, error),
            sent: false,
          };
        }
        await this.deps.api.sendInvite(channelId, code, phone);
        sent = true;
        error = null;
      } catch (err) {
        this.log.warn('invite link could not be sent', {
          groupId: group.id,
          err: errText(err),
        });
        error = inviteFailure(err);
      }
    }
    return { group: await this.recordInvite(group, sent, error), sent };
  }

  /**
   * A person's Resend invite. Unlike `inviteCustomer` the outcome is answered, not only recorded, and a group with
   * no usable stored link fetches one for this send (it is not stored). A refusal records nothing. The cooldown is
   * spent atomically by `claimInvite` just before the gateway, so simultaneous requests send once and a failed
   * attempt (which may have reached the customer) waits too.
   */
  async resendInvite(groupId: string): Promise<ResendInviteResult> {
    const refused = (code: ResendInviteRefusal): ResendInviteResult => ({
      status: 'refused',
      code,
    });
    const group = await this.deps.store.get(groupId);
    if (!group || group.status !== 'ACTIVE') return refused('not_active');
    if (group.waMode === 'none') return refused('no_whatsapp');
    const { channelId, contactId, waGroupId } = group;
    if (!waGroupId) return refused('no_group_yet');
    if (!channelId || !contactId) return refused('detached');

    if (group.customerMembership === 'joined') return refused('already_joined');

    const consent = await this.deps.consent(contactId);
    if (!consent.allowed || !consent.phone)
      return refused(consent.reason ?? 'no_phone');

    if (
      !(await this.deps.store.claimInvite(
        group.id,
        INVITE_RESEND_COOLDOWN_MS / 1000
      ))
    )
      return refused('too_soon');

    let error: string | null = null;
    try {
      const code =
        inviteCodeOf(group.inviteLink) ??
        inviteCodeOf(await this.deps.api.getInviteLink(channelId, waGroupId));
      if (code) await this.deps.api.sendInvite(channelId, code, consent.phone);
      else error = INVITE_NO_LINK;
    } catch (err) {
      this.log.warn('invite link could not be resent', {
        groupId: group.id,
        err: errText(err),
      });
      error = inviteFailure(err);
    }
    const recorded = await this.recordInvite(group, error === null, error);
    return error === null
      ? { status: 'sent', group: recorded }
      : { status: 'failed', reason: error };
  }

  /** The group as it stands after the record; a failed record is logged, since the send already happened (or not). */
  private async recordInvite(
    group: SubmissionGroup,
    sent: boolean,
    error: string | null
  ): Promise<SubmissionGroup> {
    try {
      if (await this.deps.store.noteInvite(group.id, sent, error))
        return (await this.deps.store.get(group.id)) ?? group;
    } catch (err) {
      this.log.warn('invite outcome could not be recorded', {
        groupId: group.id,
        sent,
        err: errText(err),
      });
    }
    return group;
  }

  /**
   * After a failed attach: `waGroupId` is live only when the re-read row stores exactly this id (an attach that
   * threw after committing). Whapi's createGroup has no idempotency key, so nobody else can ever attach the group
   * we created: a row still pending, holding another group, ENDED or gone means ours is an orphan and is closed
   * (a pending row's group is recreated by the cron). A failed re-read keeps it open, since it may be live.
   */
  private async discardIfOrphan(
    group: SubmissionGroup,
    waGroupId: string,
    why: unknown
  ): Promise<SubmissionGroup | null> {
    let current: SubmissionGroup | null;
    try {
      current = await this.deps.store.get(group.id);
    } catch (err) {
      this.log.warn('WhatsApp group kept open: group could not be re-read', {
        groupId: group.id,
        waGroupId,
        why: errText(why),
        err: errText(err),
      });
      return null;
    }
    const live = current !== null && current.waGroupId === waGroupId;
    if (!live && group.channelId !== null) {
      try {
        await this.deps.api.closeGroup(group.channelId, waGroupId);
      } catch (err) {
        this.log.warn('orphan WhatsApp group could not be closed', {
          groupId: group.id,
          waGroupId,
          why: errText(why),
          err: errText(err),
        });
      }
    }
    return current;
  }

  private async releaseClaimQuietly(
    groupId: string,
    token: string,
    error: string | null
  ): Promise<void> {
    try {
      await this.deps.store.releaseCreateClaim(groupId, token, error);
    } catch (err) {
      // The lease expires on its own; until then a retry returns the pending group.
      this.log.warn('create claim could not be released', {
        groupId,
        err: errText(err),
      });
    }
  }

  /** Sends `text` into the group from its hosting number, prefixed with the sender's name and label. */
  async sendFromCrm(input: {
    groupId: string;
    userId: string;
    text: string;
  }): Promise<{
    messageId: string;
    prefixedBody: string;
    waMessageId: string;
  }> {
    const { store, api } = this.deps;
    const group = await store.get(input.groupId);
    if (!group) throw new SubmissionGroupSendRefusedError('GROUP_NOT_FOUND');
    if (group.waMode === 'none')
      throw new SubmissionGroupSendRefusedError('NO_WHATSAPP_GROUP');
    if (group.waGroupId === null)
      throw new SubmissionGroupSendRefusedError('GROUP_NOT_READY');
    // 115 detaches a group whose number or contact was deleted: no gateway to
    // send through, and no customer the CRM still keeps.
    if (group.channelId === null)
      throw new SubmissionGroupSendRefusedError('NUMBER_REMOVED');
    if (group.contactId === null)
      throw new SubmissionGroupSendRefusedError('CONTACT_REMOVED');
    const { channelId, contactId, waGroupId } = group;
    const name = await this.deps.displayName(input.userId, group.accountId);
    if (!name) throw new SubmissionGroupSendRefusedError('UNKNOWN_USER');
    // The prefix label is the open access row's label; sg_send_begin re-decides under the group lock.
    const label = await store.openAccessLabel(group.id, input.userId);
    if (!label) throw new SubmissionGroupSendRefusedError('SEND_NOT_ALLOWED');
    const prefixed = prefixMessage(name, STAFF_LABEL_TEXT[label], input.text);

    // The row exists (pending) before anything goes to the gateway.
    const messageId = await store.beginSend(
      group.id,
      input.userId,
      input.text,
      prefixed
    );
    if (messageId === null)
      throw new SubmissionGroupSendRefusedError('SEND_NOT_ALLOWED');

    let consent: ConsentAnswer;
    try {
      consent = await this.deps.consent(contactId);
    } catch (err) {
      await this.settleQuietly(messageId, 'failed');
      throw err;
    }
    if (!consent.allowed && consent.reason) {
      await this.settleQuietly(messageId, 'blocked');
      throw new SubmissionGroupSendBlockedError(consent.reason);
    }
    // A missing phone does not block a group send: the customer is already in the group.

    let sent: { waMessageId: string };
    try {
      sent = await api.sendGroupText(channelId, waGroupId, prefixed);
    } catch (err) {
      // The gateway may have sent it and lost only the answer: if Whapi's
      // echo (inbound.ts) already settled the row 'sent', telling the user
      // it failed would invite a duplicate resend.
      const echoed = await this.echoedSent(messageId);
      if (echoed !== null)
        throw new SubmissionGroupSentNotRecordedError(messageId, echoed, err);
      // The echo can still land between that read and this settle: then
      // the row is no longer pending, and a second read finds it sent.
      if (!(await this.settleQuietly(messageId, 'failed'))) {
        const late = await this.echoedSent(messageId);
        if (late !== null)
          throw new SubmissionGroupSentNotRecordedError(messageId, late, err);
      }
      throw err;
    }
    // Not pending any more (swept, or settled elsewhere) but WhatsApp has
    // it: report it as sent-not-recorded, never as a failure to resend.
    if (!(await this.settleSent(messageId, sent.waMessageId))) {
      throw new SubmissionGroupSentNotRecordedError(
        messageId,
        sent.waMessageId,
        new Error(`message ${messageId} is no longer pending`)
      );
    }
    return { messageId, prefixedBody: prefixed, waMessageId: sent.waMessageId };
  }

  /**
   * 170: the welcome message, once, when the WhatsApp group is ready. The key
   * makes a repeat a no-op. Never throws: a failed welcome must not fail the
   * request or the cron pass that created the group.
   */
  async sendWelcomeIfDue(groupId: string): Promise<SystemSendResult | null> {
    try {
      const group = await this.deps.store.get(groupId);
      if (
        !group ||
        group.waMode !== 'group' ||
        group.waGroupId === null ||
        group.status !== 'ACTIVE'
      )
        return null;
      const details = (await this.deps.welcomeDetails?.(groupId)) ?? null;
      return await this.sendSystem({
        groupId,
        kind: 'welcome',
        key: 'welcome',
        text: welcomeMessage({
          customerName: group.customerName ?? null,
          product: details?.product ?? null,
          bankName: details?.bankName ?? null,
        }),
      });
    } catch (err) {
      this.log.warn('welcome message not sent', { groupId, err });
      return null;
    }
  }

  /**
   * Sends an automatic message (170: welcome, status update) into the group
   * from its hosting number, with no name prefix. Same safety as
   * sendFromCrm: the row exists before the gateway, consent is re-checked,
   * and a gateway error settles the row 'failed' and is rethrown (unless
   * Whapi's echo shows it went out: SubmissionGroupSentNotRecordedError).
   * `key` makes it at most once per group: a repeat answers `duplicate`.
   */
  async sendSystem(input: {
    groupId: string;
    kind: SystemKind;
    key: string;
    text: string;
  }): Promise<SystemSendResult> {
    const { store, api } = this.deps;
    const begun = await store.beginSystemSend(
      input.groupId,
      input.kind,
      input.key,
      input.text
    );
    if ('refused' in begun) {
      return begun.refused === 'DUPLICATE'
        ? {
            status: 'duplicate',
            messageId: begun.id,
            sendStatus: begun.sendStatus,
          }
        : { status: 'refused', code: begun.refused };
    }
    const messageId = begun.id;

    // sg_send_begin_system checked the number, group and contact under the
    // group lock; they are frozen or only ever cleared, so a re-read that
    // finds one gone means it went in between and nothing may be sent.
    let group: SubmissionGroup | null;
    try {
      group = await store.get(input.groupId);
    } catch (err) {
      await this.settleQuietly(messageId, 'failed');
      throw err;
    }
    if (!group?.channelId || !group.waGroupId || !group.contactId) {
      await this.settleQuietly(messageId, 'failed');
      return {
        status: 'refused',
        code: !group
          ? 'NOT_FOUND'
          : !group.waGroupId
            ? 'GROUP_NOT_READY'
            : !group.channelId
              ? 'NUMBER_REMOVED'
              : 'CONTACT_REMOVED',
      };
    }
    const { channelId, contactId, waGroupId } = group;

    let consent: ConsentAnswer;
    try {
      consent = await this.deps.consent(contactId);
    } catch (err) {
      await this.settleQuietly(messageId, 'failed');
      throw err;
    }
    if (!consent.allowed && consent.reason) {
      await this.settleQuietly(messageId, 'blocked');
      return { status: 'blocked', reason: consent.reason };
    }

    let sent: { waMessageId: string };
    try {
      sent = await api.sendGroupText(channelId, waGroupId, input.text);
    } catch (err) {
      // As sendFromCrm: an echo that already settled the row 'sent' means
      // WhatsApp has it, and reporting a failure would invite a resend.
      const echoed = await this.echoedSent(messageId);
      if (echoed !== null)
        throw new SubmissionGroupSentNotRecordedError(messageId, echoed, err);
      if (!(await this.settleQuietly(messageId, 'failed'))) {
        const late = await this.echoedSent(messageId);
        if (late !== null)
          throw new SubmissionGroupSentNotRecordedError(messageId, late, err);
      }
      throw err;
    }
    if (!(await this.settleSent(messageId, sent.waMessageId))) {
      throw new SubmissionGroupSentNotRecordedError(
        messageId,
        sent.waMessageId,
        new Error(`message ${messageId} is no longer pending`)
      );
    }
    return { status: 'sent', messageId, waMessageId: sent.waMessageId };
  }

  /**
   * Settles an accepted send 'sent'. A settle that throws is retried once;
   * a second failure (a throw, or the row no longer pending because the
   * first attempt may have landed) is SubmissionGroupSentNotRecordedError,
   * never a generic error, because the message is already in WhatsApp.
   * A row found no longer pending is re-read: Whapi's echo of this very
   * send (inbound.ts) or the first attempt may already have settled it
   * 'sent' with this id, and that is a success.
   */
  private async settleSent(
    messageId: string,
    waMessageId: string
  ): Promise<boolean> {
    const { store } = this.deps;
    let settled: boolean;
    let first: unknown = null;
    try {
      settled = await store.settleSend(messageId, 'sent', waMessageId);
    } catch (err) {
      first = err;
      this.log.warn('sent group message could not be settled; retrying', {
        messageId,
        err: errText(err),
      });
      try {
        settled = await store.settleSend(messageId, 'sent', waMessageId);
      } catch (retryErr) {
        throw new SubmissionGroupSentNotRecordedError(
          messageId,
          waMessageId,
          retryErr
        );
      }
    }
    if (settled) return true;
    if (await this.alreadySent(messageId, waMessageId)) return true;
    if (first !== null)
      throw new SubmissionGroupSentNotRecordedError(
        messageId,
        waMessageId,
        first
      );
    return false;
  }

  /** True if the row is already 'sent' with this WhatsApp id; a failed read is false. */
  private async alreadySent(
    messageId: string,
    waMessageId: string
  ): Promise<boolean> {
    try {
      const state = await this.deps.store.sendState(messageId);
      return state?.sendStatus === 'sent' && state.waMessageId === waMessageId;
    } catch (err) {
      this.log.warn('settled group message could not be re-read', {
        messageId,
        err: errText(err),
      });
      return false;
    }
  }

  /** The WhatsApp id of a row already settled 'sent'; null otherwise, or when the read fails. */
  private async echoedSent(messageId: string): Promise<string | null> {
    try {
      const state = await this.deps.store.sendState(messageId);
      return state?.sendStatus === 'sent' ? (state.waMessageId ?? '') : null;
    } catch (err) {
      this.log.warn(
        'group message could not be re-read after a gateway error',
        {
          messageId,
          err: errText(err),
        }
      );
      return null;
    }
  }

  /** Settles a row on an error path without masking the original error. */
  private async settleQuietly(
    messageId: string,
    status: 'blocked' | 'failed'
  ): Promise<boolean> {
    try {
      return await this.deps.store.settleSend(messageId, status);
    } catch (err) {
      this.log.warn('pending group message could not be settled', {
        messageId,
        status,
        err: errText(err),
      });
      return false;
    }
  }

  /** Ends the group when due and closes the WhatsApp group; retries a close that failed earlier. */
  async endIfDue(input: {
    groupId: string;
    status: string;
    lastActivityAt: Date;
    idleDays: number | null;
    now: Date;
    finalList?: readonly string[];
  }): Promise<EndResult> {
    const { store } = this.deps;
    let group = await store.get(input.groupId);
    if (!group) throw new Error(`submission group ${input.groupId} not found`);
    const none = { closed: false, closeError: null, closeDeferred: false };
    let reason: string | null = null;
    let ended = false;
    if (group.status === 'ACTIVE') {
      const d = shouldEnd({
        status: input.status,
        lastActivityAt: input.lastActivityAt,
        idleDays: input.idleDays,
        now: input.now,
        ...(input.finalList ? { finalList: input.finalList } : {}),
      });
      if (!d.end) return { ended: false, reason: null, ...none };
      reason = d.reason;
      ended = await store.end(group.id, d.reason);
      group = (await store.get(group.id)) ?? group;
    }
    return this.closeEnded(group, ended, reason);
  }

  /** Ends the group now (an admin's manual end, reason e.g. 'MANUAL') and closes the WhatsApp group. */
  async endNow(groupId: string, reason: string): Promise<EndResult> {
    const { store } = this.deps;
    let group = await store.get(groupId);
    if (!group) throw new Error(`submission group ${groupId} not found`);
    let ended = false;
    if (group.status === 'ACTIVE') {
      ended = await store.end(group.id, reason);
      group = (await store.get(group.id)) ?? group;
    }
    return this.closeEnded(group, ended, ended ? reason : null);
  }

  /** Cron: retries the WhatsApp close of an ENDED group (deferred or failed earlier); never ends anything. */
  async retryClose(groupId: string): Promise<EndResult> {
    const group = await this.deps.store.get(groupId);
    if (!group) throw new Error(`submission group ${groupId} not found`);
    return this.closeEnded(group, false, null);
  }

  /** The close step: an ENDED group's WhatsApp group is closed once no 'out' row is pending. */
  private async closeEnded(
    group: SubmissionGroup,
    ended: boolean,
    reason: string | null
  ): Promise<EndResult> {
    const { store } = this.deps;
    const none = { closed: false, closeError: null, closeDeferred: false };
    // A 'none' group (136) has no WhatsApp group to close.
    if (
      group.waMode === 'none' ||
      group.status !== 'ENDED' ||
      group.waGroupId === null
    )
      return { ended, reason, ...none };
    if (group.waClosedAt !== null)
      return { ended, reason, ...none, closed: true };
    // ENDED: no new 'out' row can be written, so the pending count only falls. A send begun before the end completes
    // (and is stored) before the WhatsApp group is closed.
    // The number was removed (115 detaches the group): nothing can close it any more.
    if (group.channelId === null)
      return { ended, reason, ...none, closeError: 'number_removed' };
    // 170: after a final status the group stays open CLOSE_HOLD_DAYS so the
    // customer still gets the closing update; the cron's close retry
    // (listUnclosedEnded) closes it once the hold is over. An unreadable
    // hold keeps the group open: closing early cannot be undone.
    let holdUntil: Date | null;
    try {
      holdUntil = await store.closeHoldUntil(group.id);
    } catch (err) {
      this.log.warn('close hold could not be read; close deferred', {
        groupId: group.id,
        err: errText(err),
      });
      return { ended, reason, ...none, closeDeferred: true };
    }
    if (
      holdUntil !== null &&
      holdUntil.getTime() > (this.deps.now?.() ?? new Date()).getTime()
    )
      return { ended, reason, ...none, closeDeferred: true };
    if ((await store.countPendingOut(group.id)) > 0)
      return { ended, reason, ...none, closeDeferred: true };
    try {
      await this.deps.api.closeGroup(group.channelId, group.waGroupId);
    } catch (err) {
      const msg = errText(err);
      await store.recordWaCloseError(group.id, msg);
      return { ended, reason, ...none, closeError: msg };
    }
    await store.markWaClosed(group.id);
    return { ended, reason, ...none, closed: true };
  }

  /**
   * Settles as 'failed' every 'out' row pending for longer than `olderThanMs`, so a sender that died before
   * settling cannot defer a WhatsApp close forever. `olderThanMs` must exceed the longest gateway send.
   */
  async sweepStalePending(input: {
    olderThanMs: number;
    now?: Date;
  }): Promise<{ failed: string[] }> {
    const now = input.now ?? this.deps.now?.();
    return {
      failed: await this.deps.store.failStalePending(input.olderThanMs, now),
    };
  }

  /** Archive view: who may read is decided in SQL from the user id; no audit row, no messages. */
  async viewArchive(input: {
    groupId: string;
    userId: string;
  }): Promise<ArchiveResult> {
    const now = this.deps.now?.();
    return this.deps.store.readArchive(input.groupId, input.userId, {
      ...(now ? { now } : {}),
      windowDays:
        this.deps.archiveSupervisorWindowDays ??
        DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS,
    });
  }
}
