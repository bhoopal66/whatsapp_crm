import { describe, expect, it, vi } from 'vitest';

import { WhapiError } from '@/lib/whatsapp/whapi-api';

import type { StaffLabel } from './rules';
import {
  SubmissionGroupChannelError,
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendNotStoredError,
  SubmissionGroupSendUnconfirmedError,
  SubmissionGroupNotAttemptedError,
  SubmissionGroupSystemNotSentError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
  SubmissionGroupService,
  type SubmissionGroupServiceDeps,
  CLOSE_GIVE_UP_MS,
  MAX_CREATE_ATTEMPTS,
  unconfirmedCreate,
  type FoundGroup,
  type GroupMediaSend,
  type GroupStore,
  type GroupsApi,
  failedLast,
  isNumberFailure,
  SubmissionGroupCreateUnsettledError,
  SubmissionGroupNumberDisconnectedError,
  unconfirmedError,
} from './service';
import type {
  AddNumberBegin,
  ConsentAnswer,
  GroupMessage,
  SendStatus,
  SgMediaType,
  SgOutMedia,
  SubmissionGroup,
} from './store';
import { createRefusedText } from './wa-errors';

const ACC = 'acc-1';
const CH = 'ch-1';
const DAY = 86_400_000;

/** In-memory stand-in for the sg_* RPCs (the SQL itself is asserted by verify-submission-groups.sql). */
class FakeStore implements GroupStore {
  memberships: [string, string][] = [];
  async noteCustomerMembership(groupId: string, state: string) {
    this.memberships.push([groupId, state]);
    return true;
  }
  groups = new Map<string, SubmissionGroup>();
  claims = new Map<string, { token: string; until: number }>();
  access: {
    groupId: string;
    userId: string;
    label: StaffLabel;
    removed: boolean;
  }[] = [];
  messages: (GroupMessage & { groupId: string; systemKey?: string })[] = [];
  admins = new Set(['adam']);
  audit: { groupId: string; userId: string }[] = [];
  invites: { groupId: string; sent: boolean; error: string | null }[] = [];
  noteInviteFails = false;
  /** The clock `claimInvite` judges the cooldown by; tests set it to the service's. */
  claimNow = new Date();
  claimed = new Set<string>();
  claimCalls: { groupId: string; seconds: number }[] = [];
  /** Answers true once per group, like the SQL: a claim or a sent invite inside the window refuses. */
  async claimInvite(groupId: string, seconds: number) {
    this.claimCalls.push({ groupId, seconds });
    const g = this.groups.get(groupId);
    if (!g || g.status !== 'ACTIVE' || this.claimed.has(groupId)) return false;
    if (
      g.inviteSentAt &&
      this.claimNow.getTime() - g.inviteSentAt.getTime() < seconds * 1000
    )
      return false;
    this.claimed.add(groupId);
    return true;
  }
  private seq = 0;

  async open(i: Parameters<GroupStore['open']>[0]) {
    const found = await this.findByRef(i.accountId, i.submissionRef);
    if (found) return { groupId: found.id, created: false };
    const id = `g-${++this.seq}`;
    const now = new Date();
    this.groups.set(id, {
      id,
      accountId: i.accountId,
      submissionRef: i.submissionRef,
      contactId: i.contactId,
      channelId: i.channelId,
      waMode: i.waMode ?? 'group',
      subject: i.subject,
      coordinatorPhone: i.coordinatorPhone,
      coordinatorPhones: [...(i.coordinatorPhones ?? [])],
      status: 'ACTIVE',
      waGroupId: null,
      inviteLink: null,
      submissionStatus: null,
      createdAt: now,
      lastActivityAt: now,
      endedAt: null,
      endReason: null,
      waCreateError: null,
      waClosedAt: null,
      waCloseError: null,
      inviteSentAt: null,
      inviteSendError: null,
    });
    for (const a of i.access)
      this.access.push({ groupId: id, ...a, removed: false });
    return { groupId: id, created: true };
  }
  async get(id: string) {
    const g = this.groups.get(id);
    const until = this.claims.get(id)?.until;
    return g
      ? { ...g, waCreateClaimedUntil: until ? new Date(until) : null }
      : null;
  }
  rivals: { held: string[]; twin: boolean } = { held: [], twin: false };
  async adoptionRivals() {
    return this.rivals;
  }
  async findByRef(acc: string, ref: string) {
    const g = [...this.groups.values()].find(
      (x) => x.accountId === acc && x.submissionRef === ref
    );
    return g ? { ...g } : null;
  }
  async listPendingCreates(before: Date, o: { accountId?: string } = {}) {
    return [...this.groups.values()].filter(
      (g) =>
        g.status === 'ACTIVE' &&
        !g.waGroupId &&
        g.createdAt < before &&
        (!o.accountId || g.accountId === o.accountId)
    );
  }
  async openAccessLabel(groupId: string, userId: string) {
    return (
      this.access.find(
        (a) => a.groupId === groupId && a.userId === userId && !a.removed
      )?.label ?? null
    );
  }
  async claimCreate(id: string, leaseMs: number, now?: Date) {
    const g = this.groups.get(id);
    const t = (now ?? new Date()).getTime();
    const c = this.claims.get(id);
    if (!g || g.status !== 'ACTIVE' || g.waGroupId || (c && c.until > t))
      return null;
    const token = `tok-${++this.seq}`;
    this.claims.set(id, { token, until: t + leaseMs });
    return token;
  }
  async releaseCreateClaim(id: string, token: string, error: string | null) {
    if (this.claims.get(id)?.token !== token) return false;
    this.claims.delete(id);
    // Like the SQL: no error given keeps the last one.
    if (error !== null) this.groups.get(id)!.waCreateError = error;
    return true;
  }
  async attachWaGroup(
    id: string,
    wa: string,
    link: string | null,
    token: string
  ) {
    const g = this.groups.get(id)!;
    if (
      g.waGroupId ||
      g.status !== 'ACTIVE' ||
      this.claims.get(id)?.token !== token
    )
      return false;
    Object.assign(g, { waGroupId: wa, inviteLink: link, waCreateError: null });
    this.claims.delete(id);
    return true;
  }
  async beginSend(id: string, userId: string, body: string, prefixed: string) {
    const g = this.groups.get(id);
    if (
      !g ||
      g.status !== 'ACTIVE' ||
      !(await this.openAccessLabel(id, userId))
    )
      return null;
    const mid = String(++this.seq);
    this.messages.push({
      groupId: id,
      id: mid,
      direction: 'out',
      senderUserId: userId,
      senderWaId: null,
      senderKind: null,
      type: 'text',
      body,
      prefixedBody: prefixed,
      media: null,
      waMessageId: null,
      sendStatus: 'pending',
      postEnd: false,
      createdAt: new Date(),
      waTimestamp: null,
    });
    return mid;
  }
  async beginMediaSend(
    id: string,
    userId: string,
    type: SgMediaType,
    body: string,
    prefixed: string,
    media: SgOutMedia
  ) {
    const mid = await this.beginSend(id, userId, body, prefixed);
    if (mid === null) return null;
    Object.assign(
      this.messages.find((m) => m.id === mid)!,
      { type, media }
    );
    return mid;
  }
  /** 170: per group; absent = no hold (the SQL rule is asserted by verify-submission-group-system-messages). */
  holds = new Map<string, Date | (() => never)>();
  async closeHoldUntil(id: string) {
    const h = this.holds.get(id);
    if (typeof h === 'function') return h();
    return h ?? null;
  }
  async beginSystemSend(
    id: string,
    kind: 'welcome' | 'status_update',
    key: string,
    body: string
  ) {
    const g = this.groups.get(id);
    if (!g) return { refused: 'NOT_FOUND' as const };
    const dup = this.messages.find(
      (m) => m.groupId === id && m.systemKey === key
    );
    if (dup)
      return {
        refused: 'DUPLICATE' as const,
        id: dup.id,
        sendStatus: dup.sendStatus,
      };
    if (!g.waGroupId) return { refused: 'GROUP_NOT_READY' as const };
    if (g.status !== 'ACTIVE') return { refused: 'ENDED' as const };
    const mid = String(++this.seq);
    this.messages.push({
      groupId: id,
      id: mid,
      direction: 'out',
      senderUserId: null,
      senderWaId: null,
      senderKind: null,
      type: 'text',
      body,
      prefixedBody: body,
      media: null,
      waMessageId: null,
      sendStatus: 'pending',
      postEnd: false,
      createdAt: new Date(),
      waTimestamp: null,
      systemKind: kind,
      systemKey: key,
    });
    return { id: mid };
  }
  async settleSend(
    mid: string,
    status: Exclude<SendStatus, 'pending'>,
    wa: string | null = null
  ) {
    const m = this.messages.find((x) => x.id === mid);
    if (!m || m.sendStatus !== 'pending') return false;
    m.sendStatus = status;
    m.waMessageId = status === 'sent' ? wa : null;
    return true;
  }
  async sendState(mid: string) {
    const m = this.messages.find((x) => x.id === mid);
    return m ? { sendStatus: m.sendStatus, waMessageId: m.waMessageId } : null;
  }
  async end(id: string, reason: string) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'ACTIVE') return false;
    Object.assign(g, {
      status: 'ENDED',
      endedAt: new Date(),
      endReason: reason,
    });
    for (const a of this.access) if (a.groupId === id) a.removed = true;
    return true;
  }
  async markWaClosed(id: string) {
    const g = this.groups.get(id)!;
    if (g.status !== 'ENDED' || g.waClosedAt) return false;
    Object.assign(g, { waClosedAt: new Date(), waCloseError: null });
    return true;
  }
  async recordWaCloseError(id: string, error: string) {
    this.groups.get(id)!.waCloseError = error;
    return true;
  }
  async countPendingOut(id: string) {
    return this.messages.filter(
      (m) => m.groupId === id && m.sendStatus === 'pending'
    ).length;
  }
  /** 211: what beginAddNumber answers, and every settle. */
  addBegin: AddNumberBegin = {
    ok: true,
    id: 'add-1',
    channelId: 'ch-x',
    waGroupId: 'wa-x@g.us',
    inviteLink: null,
  };
  addBegun: { groupId: string; userId: string; phone: string }[] = [];
  addSettles: { id: string; status: string; error: string | null }[] = [];
  addSettleFails = false;
  async beginAddNumber(groupId: string, userId: string, phone: string) {
    this.addBegun.push({ groupId, userId, phone });
    return this.addBegin;
  }
  async settleAddNumber(id: string, status: string, error: string | null) {
    if (this.addSettleFails) throw new Error('db down');
    this.addSettles.push({ id, status, error });
    return true;
  }
  async noteInvite(groupId: string, sent: boolean, error: string | null) {
    if (this.noteInviteFails) throw new Error('db down');
    this.invites.push({ groupId, sent, error });
    const g = this.groups.get(groupId);
    if (!g || g.status !== 'ACTIVE') return false;
    if (sent)
      Object.assign(g, { inviteSentAt: new Date(), inviteSendError: null });
    else g.inviteSendError = error;
    return true;
  }
  async failStalePending(olderThanMs: number, now?: Date) {
    const cut = (now ?? new Date()).getTime() - olderThanMs;
    const hit = this.messages.filter(
      (m) => m.sendStatus === 'pending' && m.createdAt.getTime() < cut
    );
    for (const m of hit) m.sendStatus = 'failed';
    return hit.map((m) => m.id);
  }
  async readArchive(
    id: string,
    userId: string,
    o: { now?: Date; windowDays: number }
  ) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'ENDED') return { allowed: false } as const;
    const label = this.access.find(
      (a) => a.groupId === id && a.userId === userId
    )?.label;
    const t = (o.now ?? new Date()).getTime();
    const ok =
      this.admins.has(userId) ||
      ((label === 'coordinator' || label === 'team_lead') &&
        t < g.endedAt!.getTime() + o.windowDays * DAY);
    if (!ok) return { allowed: false } as const;
    this.audit.push({ groupId: id, userId });
    return {
      allowed: true,
      messages: this.messages.filter((m) => m.groupId === id),
    } as const;
  }
}

/** Records calls; `fail` makes the next call of a method throw; createGroup honours the idempotency key. */
class FakeApi implements GroupsApi {
  calls: { method: string; args: unknown[] }[] = [];
  fail = new Set<string>();
  byKey = new Map<string, string>();
  hook: (() => Promise<void>) | null = null;
  /** What createGroup answers: who WhatsApp refused, and the link when set. */
  refused: string[] = [];
  link: string | null | undefined = undefined;
  inviteError: Error | null = null;
  fetchedLink = 'https://chat.whatsapp.com/FETCHED';
  fetchLinkError: Error | null = null;
  private seq = 0;
  private maybeFail(m: string) {
    if (!this.fail.delete(m)) return;
    const err = new Error(`${m} failed`);
    // A create the gateway refused; `createError` is for any other outcome.
    throw m === 'createGroup' ? Object.assign(err, { status: 400 }) : err;
  }
  createError: Error | null = null;
  async createGroup(ch: string, parts: string[], subject: string, key: string) {
    this.calls.push({ method: 'createGroup', args: [ch, parts, subject, key] });
    if (this.hook) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    this.maybeFail('createGroup');
    if (this.createError) throw this.createError;
    const wa = this.byKey.get(key) ?? `wag-${++this.seq}@g.us`;
    this.byKey.set(key, wa);
    return {
      waGroupId: wa,
      inviteLink:
        this.link === undefined ? `https://chat.whatsapp.com/${wa}` : this.link,
      refused: this.refused,
    };
  }
  async sendInvite(ch: string, code: string, to: string) {
    this.calls.push({ method: 'sendInvite', args: [ch, code, to] });
    if (this.inviteError) throw this.inviteError;
  }
  addOutcome: 'added' | 'refused' = 'added';
  addError: Error | null = null;
  async addParticipant(ch: string, wa: string, phone: string) {
    this.calls.push({ method: 'addParticipant', args: [ch, wa, phone] });
    if (this.addError) throw this.addError;
    return this.addOutcome;
  }
  found: FoundGroup[] | Error = [];
  async findCreatedGroups(ch: string, subject: string, since: Date) {
    this.calls.push({
      method: 'findCreatedGroups',
      args: [ch, subject, since],
    });
    if (this.found instanceof Error) throw this.found;
    return this.found;
  }
  async getInviteLink(ch: string, wa: string) {
    this.calls.push({ method: 'getInviteLink', args: [ch, wa] });
    if (this.fetchLinkError) throw this.fetchLinkError;
    return this.fetchedLink;
  }
  async sendGroupText(ch: string, wa: string, text: string) {
    this.calls.push({ method: 'sendGroupText', args: [ch, wa, text] });
    if (this.hook) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    this.maybeFail('sendGroupText');
    return { waMessageId: `wamid-${++this.seq}` };
  }
  async sendGroupMedia(ch: string, wa: string, media: GroupMediaSend) {
    this.calls.push({ method: 'sendGroupMedia', args: [ch, wa, media] });
    this.maybeFail('sendGroupMedia');
    return { waMessageId: `wamid-${++this.seq}` };
  }
  /** `leaveAnyway` of each close, beside `calls`. */
  leaveAnyway: boolean[] = [];
  async closeGroup(ch: string, wa: string, opts?: { leaveAnyway?: boolean }) {
    this.calls.push({ method: 'closeGroup', args: [ch, wa] });
    this.leaveAnyway.push(opts?.leaveAnyway ?? false);
    this.maybeFail('closeGroup');
  }
  of(m: string) {
    return this.calls.filter((c) => c.method === m);
  }
}

const NAMES: Record<string, string> = {
  ali: 'Ali',
  noor: 'Noor',
  sara: 'Sara',
  adam: 'Adam',
  eve: 'Eve',
};
const ACCESS = [
  { userId: 'ali', label: 'agent' as const },
  { userId: 'noor', label: 'coordinator' as const },
  { userId: 'sara', label: 'team_lead' as const },
];

function setup(
  o: {
    now?: () => Date;
    store?: FakeStore;
    api?: FakeApi;
    welcomeDetails?: SubmissionGroupServiceDeps['welcomeDetails'];
    logger?: SubmissionGroupServiceDeps['logger'];
    staffNumberJoined?: SubmissionGroupServiceDeps['staffNumberJoined'];
  } = {}
) {
  const store = o.store ?? new FakeStore();
  const api = o.api ?? new FakeApi();
  const consent: { answer: ConsentAnswer; asked: number; error?: Error } = {
    answer: { allowed: true, phone: '971500000001' },
    asked: 0,
  };
  const svc = new SubmissionGroupService({
    store,
    api,
    consent: async () => {
      consent.asked++;
      if (consent.error) throw consent.error;
      return consent.answer;
    },
    displayName: async (u) => NAMES[u] ?? null,
    logger: o.logger ?? { warn: () => {} },
    ...(o.welcomeDetails ? { welcomeDetails: o.welcomeDetails } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.staffNumberJoined ? { staffNumberJoined: o.staffNumberJoined } : {}),
  });
  const open = (
    ref = 'S-1',
    coordinatorPhone: string | null = null,
    coordinatorPhones?: string[]
  ) =>
    svc.openForSubmission({
      accountId: ACC,
      submissionRef: ref,
      contactId: 'c-1',
      channelId: CH,
      subject: `Case ${ref}`,
      coordinatorPhone,
      coordinatorPhones,
      access: ACCESS,
      keyId: null,
      customerName: null,
    });
  return { store, api, svc, consent, open };
}

const opened = async (s: ReturnType<typeof setup>, ref = 'S-1') => {
  const r = await s.open(ref);
  if (r.consentRequired) throw new Error('unexpected consentRequired');
  return r.group;
};
const due = (groupId: string) => ({
  groupId,
  status: 'approved',
  lastActivityAt: new Date(),
  idleDays: null,
  now: new Date(),
});

describe('SubmissionGroupService.openForSubmission', () => {
  it('creates once on the hosting number with customer + coordinator phone; a repeat returns the same group', async () => {
    const s = setup();
    const r = await s.open('S-1', '971500000009');
    expect(r).toMatchObject({ consentRequired: false, created: true });
    const g = r.consentRequired ? null : r.group;
    expect(g).toMatchObject({ channelId: CH, status: 'ACTIVE' });
    expect(g!.waGroupId).toMatch(/@g\.us$/);
    expect(s.api.of('createGroup')).toEqual([
      {
        method: 'createGroup',
        args: [CH, ['971500000001', '971500000009'], 'Case S-1', g!.id],
      },
    ]);
    const again = await s.open('S-1');
    expect(again).toMatchObject({ created: false, group: { id: g!.id } });
    expect(s.api.of('createGroup')).toHaveLength(1);
    expect(s.store.groups.size).toBe(1);
  });

  it("adds the row's coordinator numbers after the customer, in the stored order (142)", async () => {
    const s = setup();
    const r = await s.open('S-1', '971500000009', [
      '971500000009',
      '971500000007',
      '971500000008',
    ]);
    const g = r.consentRequired ? null : r.group;
    expect(s.api.of('createGroup')).toEqual([
      {
        method: 'createGroup',
        args: [
          CH,
          ['971500000001', '971500000009', '971500000007', '971500000008'],
          'Case S-1',
          g!.id,
        ],
      },
    ]);
  });

  it('never re-adds coordinator_phone beside a full 142 list, nor the customer in + form (142)', async () => {
    const s = setup();
    s.consent.answer = { allowed: true, phone: '+971500000001' };
    const five = [2, 3, 4, 5, 6].map((n) => `97150000000${n}`);
    const r = await s.open('S-1', '971500000009', five);
    const g = r.consentRequired ? null : r.group;
    expect(s.api.of('createGroup')[0].args[1]).toEqual([
      '+971500000001',
      ...five,
    ]);
    expect(g).toBeTruthy();
    const old = setup();
    old.consent.answer = { allowed: true, phone: '+971500000001' };
    await old.open('S-2', '971500000001');
    expect(old.api.of('createGroup')[0].args[1]).toEqual(['+971500000001']);
  });

  it('records nothing after a clean create, absent when refused', async () => {
    const phone = '+971500000001';
    const s = setup();
    s.consent.answer = { allowed: true, phone };
    await s.open('S-1', '971500000009');
    expect(s.store.memberships).toEqual([]);
    const no = setup();
    no.consent.answer = { allowed: true, phone };
    const real = no.api.createGroup.bind(no.api);
    no.api.createGroup = async (...a: Parameters<typeof real>) => ({
      ...(await real(...a)),
      refused: ['971500000001'],
    });
    const n = await no.open('S-2', '971500000009');
    expect(no.store.memberships).toEqual([
      [n.consentRequired ? '' : n.group.id, 'absent'],
    ]);
  });

  it('consent refused: no row and no gateway call', async () => {
    const s = setup();
    s.consent.answer = { allowed: false, phone: '1', reason: 'opted_out' };
    expect(await s.open()).toEqual({
      consentRequired: true,
      group: null,
      inviteLink: null,
    });
    expect(s.store.groups.size).toBe(0);
    expect(s.api.calls).toEqual([]);
  });

  it('pending → retry finishes it: one row, one WhatsApp group, the error recorded then cleared', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow(/createGroup failed/);
    const [pending] = [...s.store.groups.values()];
    expect(pending).toMatchObject({
      waGroupId: null,
      waCreateError: 'createGroup failed',
    });
    expect(s.store.claims.size).toBe(0); // released, not left to expire
    const r = await s.open();
    expect(r).toMatchObject({ group: { id: pending.id, waCreateError: null } });
    expect(s.store.groups.get(pending.id)!.waGroupId).toMatch(/@g\.us/);
    expect(s.api.of('createGroup')).toHaveLength(2);
  });

  it('consent re-checked by the claim holder before createGroup: withdrawn after a failed create → consentRequired, no second call', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    s.consent.answer = {
      allowed: false,
      phone: null,
      reason: 'do_not_contact',
    };
    expect(await s.open()).toMatchObject({ consentRequired: true });
    expect(s.api.of('createGroup')).toHaveLength(1);
    expect(s.store.claims.size).toBe(0);
  });

  it('a waiting create refused by consent says why, and is created once it changes', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    g.waCreateError = null;
    s.consent.answer = { allowed: false, phone: '1', reason: 'opted_out' };
    expect(await s.svc.retryOne(g.id)).toMatchObject({ consentRequired: true });
    expect(g.waCreateError).toBe(createRefusedText('opted_out'));
    expect(s.api.of('createGroup')).toHaveLength(1);
    s.api.fail.delete('createGroup');
    s.consent.answer = { allowed: true, phone: '+971500000001' };
    expect(await s.svc.retryOne(g.id)).toMatchObject({
      consentRequired: false,
      group: { waGroupId: expect.any(String) },
    });
  });

  it('a consent refusal keeps the unconfirmed count in front of its reason', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    const prior = { attempts: 3, at: new Date('2026-11-20T10:00:00.000Z') };
    g.waCreateError = unconfirmedError(prior, 'timed out');
    s.consent.answer = { allowed: false, phone: '1', reason: 'do_not_contact' };
    expect(await s.open()).toMatchObject({ consentRequired: true });
    expect(g.waCreateError).toBe(
      unconfirmedError(prior, createRefusedText('do_not_contact'))
    );
    expect(s.api.of('createGroup')).toHaveLength(1);
  });

  it('claim held by another caller: no gateway call, the pending group is returned; after expiry one more create', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    expect(await s.store.claimCreate(g.id, 120_000)).not.toBeNull();
    expect(await s.open()).toMatchObject({
      inviteLink: null,
      group: { id: g.id, waGroupId: null },
    });
    expect(s.api.of('createGroup')).toHaveLength(1);
    const later = setup({
      store: s.store,
      api: s.api,
      now: () => new Date(Date.now() + 121_000),
    });
    const r = await later.open();
    expect(s.api.of('createGroup')).toHaveLength(2);
    expect(r).toMatchObject({ group: { waGroupId: expect.any(String) } });
  });

  it('orphan: the loser whose created id differs from the stored one closes its own group; the same id stays open', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    // While A is inside createGroup, its lease lapses and B attaches a different group.
    s.api.hook = async () => {
      const tb = await s.store.claimCreate(
        g.id,
        120_000,
        new Date(Date.now() + 121_000)
      );
      await s.store.attachWaGroup(g.id, 'wag-winner@g.us', null, tb!);
    };
    const r = await s.open();
    expect(r).toMatchObject({ group: { waGroupId: 'wag-winner@g.us' } });
    const closed = s.api.of('closeGroup').map((c) => c.args[1]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).not.toBe('wag-winner@g.us');

    // The row stores the very id we got back (an attach that landed): nothing is closed.
    const t = setup();
    t.api.fail.add('createGroup');
    await expect(t.open('S-2')).rejects.toThrow();
    const [h] = [...t.store.groups.values()];
    t.api.byKey.set(h.id, 'wag-same@g.us');
    t.api.hook = async () => {
      const tb = await t.store.claimCreate(
        h.id,
        120_000,
        new Date(Date.now() + 121_000)
      );
      await t.store.attachWaGroup(h.id, 'wag-same@g.us', null, tb!);
    };
    await t.open('S-2');
    expect(t.api.of('closeGroup')).toEqual([]);
  });

  it('orphan: a lost claim on a still-pending row keeps our group open, for the new holder to adopt', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    // While A is inside createGroup, B takes the lapsed lease but has not attached anything yet.
    s.api.hook = async () => {
      await s.store.claimCreate(g.id, 120_000, new Date(Date.now() + 121_000));
    };
    const r = await s.open();
    expect(s.store.groups.get(g.id)!.waGroupId).toBeNull();
    expect(s.api.of('closeGroup')).toEqual([]);
    expect(r).toMatchObject({ group: { waGroupId: null } });
  });

  it('orphan: an attach that throws on a still-pending row keeps our group open, for the next attempt to adopt', async () => {
    const s = setup();
    s.store.attachWaGroup = async () => {
      throw new Error('attach: connection reset');
    };
    await expect(s.open()).rejects.toThrow(/attach/);
    const [g] = [...s.store.groups.values()];
    expect(g.waGroupId).toBeNull();
    expect(s.api.of('closeGroup')).toEqual([]);
  });

  describe('after an unconfirmed create', () => {
    const CUSTOMER = '971500000001';
    /** A row whose first create timed out, seen three minutes later. */
    async function timedOut() {
      const t = { ms: Date.now() };
      const s = setup({ now: () => new Date(t.ms) });
      s.api.createError = Object.assign(new Error('timed out'), {
        status: 503,
      });
      await expect(s.open()).rejects.toThrow('timed out');
      const [g] = [...s.store.groups.values()];
      t.ms += 180_000;
      const found = (o: Partial<FoundGroup> = {}): FoundGroup => ({
        waGroupId: 'wag-lost@g.us',
        createdAt: new Date(g.createdAt.getTime() + 2_000),
        others: [CUSTOMER],
        ...o,
      });
      const creates = () => s.api.of('createGroup').length;
      return { ...s, g, t, found, creates };
    }

    it('counts the attempt in the error; the next one adopts the group instead of making a second', async () => {
      const s = await timedOut();
      expect(unconfirmedCreate(s.g.waCreateError)?.attempts).toBe(1);
      s.api.found = [s.found()];
      expect(await s.open()).toMatchObject({
        group: { waGroupId: 'wag-lost@g.us', waCreateError: null },
        refusedParticipants: [],
      });
      expect(s.creates()).toBe(1);
      expect(s.store.groups.get(s.g.id)!.waGroupId).toBe('wag-lost@g.us');
      expect(s.api.of('findCreatedGroups')[0].args.slice(0, 2)).toEqual([
        CH,
        'Case S-1',
      ]);
    });

    it('creates again only once a whole list held no match, and not right after the failure', async () => {
      const s = await timedOut();
      s.t.ms -= 120_000;
      await expect(s.open()).rejects.toThrow(/waiting/);
      expect(s.creates()).toBe(1);
      s.t.ms += 120_000;
      s.api.createError = null;
      expect(await s.open()).toMatchObject({
        group: { waGroupId: expect.any(String) },
      });
      expect(s.creates()).toBe(2);
    });

    it('a list that could not be read creates nothing and uses up no attempt', async () => {
      const s = await timedOut();
      s.api.found = new Error('list failed');
      await expect(s.open()).rejects.toThrow('list failed');
      expect(s.creates()).toBe(1);
      expect(unconfirmedCreate(s.g.waCreateError)?.attempts).toBe(1);
      expect(s.store.claims.size).toBe(0);
    });

    it('neither adopts nor creates when the group may be another', async () => {
      for (const arrange of [
        (s: Awaited<ReturnType<typeof timedOut>>) =>
          void (s.api.found = [s.found(), s.found({ waGroupId: 'b@g.us' })]),
        (s: Awaited<ReturnType<typeof timedOut>>) => {
          s.api.found = [s.found()];
          s.store.rivals = { held: [], twin: true };
        },
        (s: Awaited<ReturnType<typeof timedOut>>) =>
          void (s.api.found = [s.found({ createdAt: null })]),
        (s: Awaited<ReturnType<typeof timedOut>>) =>
          void (s.api.found = [
            s.found({ createdAt: new Date(s.g.createdAt.getTime() - 60_000) }),
          ]),
        (s: Awaited<ReturnType<typeof timedOut>>) =>
          void (s.api.found = [
            s.found({ others: [CUSTOMER, '971599999999'] }),
          ]),
      ]) {
        const s = await timedOut();
        arrange(s);
        await expect(s.open()).rejects.toThrow(/WhatsApp group/);
        expect(s.store.groups.get(s.g.id)!.waGroupId).toBeNull();
        expect(s.creates()).toBe(1);
        expect(unconfirmedCreate(s.g.waCreateError)?.attempts).toBe(2);
      }
    });

    it("another submission's group of the same name is not a match", async () => {
      const s = await timedOut();
      s.api.createError = null;
      s.api.found = [s.found()];
      s.store.rivals = { held: ['wag-lost@g.us'], twin: false };
      const r = await s.open();
      expect(r).toMatchObject({ group: { waGroupId: expect.any(String) } });
      expect(s.store.groups.get(s.g.id)!.waGroupId).not.toBe('wag-lost@g.us');
    });

    it('a claim that lapsed while creating counts as unconfirmed and is adopted', async () => {
      const t = { ms: Date.now() };
      const s = setup({ now: () => new Date(t.ms) });
      s.store.attachWaGroup = async () => {
        throw new Error('restart');
      };
      await expect(s.open()).rejects.toThrow('restart');
      const [g] = [...s.store.groups.values()];
      delete (s.store as Partial<FakeStore>).attachWaGroup;
      t.ms += 121_000;
      s.api.found = [
        { waGroupId: 'wag-lost@g.us', createdAt: new Date(t.ms), others: [] },
      ];
      expect(await s.open()).toMatchObject({
        group: { waGroupId: 'wag-lost@g.us' },
        // Not among its members: invited, as a refused customer is.
        refusedParticipants: [CUSTOMER],
      });
      expect(s.api.of('createGroup')).toHaveLength(1);
      expect(s.store.groups.get(g.id)!.waGroupId).toBe('wag-lost@g.us');
    });

    it('stops after the last attempt with the reason kept; only a person goes on, after the lookup', async () => {
      const s = await timedOut();
      for (let n = 2; n <= MAX_CREATE_ATTEMPTS; n++) {
        await expect(s.open()).rejects.toThrow('timed out');
        s.t.ms += 180_000;
      }
      expect(s.creates()).toBe(MAX_CREATE_ATTEMPTS);
      expect(s.g.waCreateError).toMatch(
        /^Stopped after 5 attempts.*timed out$/
      );
      expect(await s.open()).toMatchObject({ group: { waGroupId: null } });
      expect(s.creates()).toBe(MAX_CREATE_ATTEMPTS);
      const lookups = s.api.of('findCreatedGroups').length;
      s.api.createError = null;
      await s.svc.retryOne(s.g.id);
      expect(s.api.of('findCreatedGroups')).toHaveLength(lookups + 1);
      expect(s.store.groups.get(s.g.id)!.waGroupId).not.toBeNull();
    });

    it('a definite refusal is retried as before: no lookup, no count', async () => {
      const s = setup();
      s.api.createError = Object.assign(new Error('bad'), { status: 400 });
      await expect(s.open()).rejects.toThrow('bad');
      const [g] = [...s.store.groups.values()];
      expect(g.waCreateError).toBe('bad');
      s.api.createError = null;
      await s.open();
      expect(s.api.of('findCreatedGroups')).toEqual([]);
    });
  });

  it('retryPending finishes groups older than the threshold and reports per group', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    expect(
      await s.svc.retryPending({ accountId: ACC, olderThanMs: 60_000 })
    ).toMatchObject({
      attempted: 0,
    });
    g.createdAt = new Date(Date.now() - 120_000);
    const r = await s.svc.retryPending({ accountId: ACC, olderThanMs: 60_000 });
    expect(r).toEqual({
      attempted: 1,
      created: [g.id],
      consentRequired: [],
      failed: [],
    });
    expect(s.store.groups.get(g.id)!.waGroupId).not.toBeNull();
  });

  describe('one bad number in the cron (retryPending)', () => {
    /** Three old pending groups: two on the first number, one on another. */
    const three = async () => {
      const s = setup();
      s.api.createError = Object.assign(new Error('bad'), { status: 400 });
      for (const ref of ['R1', 'R2', 'R3'])
        await expect(s.open(ref)).rejects.toThrow();
      s.api.createError = null;
      const rows = [...s.store.groups.values()];
      for (const g of rows) {
        g.createdAt = new Date(Date.now() - 120_000);
        g.waCreateError = null;
      }
      rows[2].channelId = 'other-number';
      s.api.calls = [];
      return { s, rows };
    };
    const input = { accountId: ACC, olderThanMs: 60_000 };

    it('skips the number after its first connection failure', async () => {
      const { s, rows } = await three();
      s.api.createError = Object.assign(new Error('timed out'), {
        status: 503,
      });
      const failedChannels = new Set<string>();
      const r = await s.svc.retryPending({ ...input, failedChannels });
      expect(s.api.of('createGroup')).toHaveLength(2);
      expect(r).toMatchObject({ attempted: 2, created: [] });
      expect(r.failed.map((f) => f.groupId)).toEqual([rows[0].id, rows[2].id]);
      expect([...failedChannels]).toEqual([rows[0].channelId, 'other-number']);
    });

    it('leaves a number that already failed in this run alone', async () => {
      const { s, rows } = await three();
      const r = await s.svc.retryPending({
        ...input,
        failedChannels: new Set([rows[0].channelId!]),
      });
      expect(r).toMatchObject({ attempted: 1, created: [rows[2].id] });
    });

    it('a refused group says nothing about its number', async () => {
      const { s } = await three();
      s.api.createError = Object.assign(new Error('bad'), { status: 400 });
      const failedChannels = new Set<string>();
      await s.svc.retryPending({ ...input, failedChannels });
      expect(s.api.of('createGroup')).toHaveLength(3);
      expect(failedChannels.size).toBe(0);
    });

    it('starts nothing once the budget is spent', async () => {
      const { s } = await three();
      let left = 1;
      const r = await s.svc.retryPending({ ...input, spent: () => left-- < 1 });
      expect(r.attempted).toBe(1);
      expect(s.api.of('createGroup')).toHaveLength(1);
    });
  });

  it('isNumberFailure: the number, not one group, and never an unsettled create', () => {
    const st = (status: number) => Object.assign(new Error('x'), { status });
    expect([401, 500, 502, 503].every((n) => isNumberFailure(st(n)))).toBe(
      true
    );
    expect([400, 403, 404, 409, 429].some((n) => isNumberFailure(st(n)))).toBe(
      false
    );
    expect(
      isNumberFailure(new SubmissionGroupCreateUnsettledError('', true))
    ).toBe(false);
    expect(isNumberFailure(new Error('db down'))).toBe(false);
  });

  it('failedLast: new work first, and another of the failed ones first each run', () => {
    const rows = ['a!', 'b', 'c!', 'd'];
    const failed = (r: string) => r.endsWith('!');
    expect(failedLast(rows, failed, 0)).toEqual(['b', 'd', 'a!', 'c!']);
    expect(failedLast(rows, failed, 120_000)).toEqual(['b', 'd', 'c!', 'a!']);
    expect(failedLast([], failed, 0)).toEqual([]);
  });

  it("retryPending leaves another account's pending groups alone", async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    g.createdAt = new Date(Date.now() - 120_000);
    expect(
      await s.svc.retryPending({ accountId: 'acc-2', olderThanMs: 60_000 })
    ).toMatchObject({ attempted: 0 });
    expect(s.api.of('createGroup')).toHaveLength(1);
  });

  it('retryOne finishes a pending create; a complete or ENDED group is returned without a gateway call', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    const r = await s.svc.retryOne(g.id);
    expect(r.consentRequired).toBe(false);
    expect(s.store.groups.get(g.id)!.waGroupId).not.toBeNull();
    await s.svc.retryOne(g.id);
    expect(s.api.of('createGroup')).toHaveLength(2);
  });
});

describe('SubmissionGroupService.sendMediaFromCrm', () => {
  const LINK =
    'https://db.example.org/storage/v1/object/public/chat-media/account-a/groups/1-scan.pdf';
  const PATH = 'account-a/groups/1-scan.pdf';
  const doc = (groupId: string, extra: Record<string, unknown> = {}) => ({
    groupId,
    userId: 'ali',
    kind: 'document' as const,
    link: LINK,
    path: PATH,
    caption: 'the form',
    filename: 'scan.pdf',
    mimeType: 'application/pdf',
    ...extra,
  });

  it('stores the media row and sends the prefixed caption from the hosting number', async () => {
    const s = setup();
    const g = await opened(s);
    const r = await s.svc.sendMediaFromCrm(doc(g.id));
    expect(r.prefixedBody).toBe('Ali (Agent): the form');
    expect(s.api.of('sendGroupMedia').map((c) => c.args)).toEqual([
      [
        CH,
        g.waGroupId,
        {
          kind: 'document',
          link: LINK,
          caption: 'Ali (Agent): the form',
          filename: 'scan.pdf',
          mimeType: 'application/pdf',
        },
      ],
    ]);
    expect(s.api.of('sendGroupText')).toEqual([]);
    const [m] = s.store.messages;
    expect(m).toMatchObject({
      type: 'document',
      body: 'the form',
      prefixedBody: 'Ali (Agent): the form',
      media: {
        link: LINK,
        mime_type: 'application/pdf',
        filename: 'scan.pdf',
        path: PATH,
      },
      sendStatus: 'sent',
      waMessageId: r.waMessageId,
    });
  });

  it("a voice note is stored as 'audio' and sent as 'voice'; no caption sends just the name", async () => {
    const s = setup();
    const g = await opened(s);
    await s.svc.sendMediaFromCrm(
      doc(g.id, {
        kind: 'voice',
        caption: undefined,
        filename: undefined,
        mimeType: 'audio/ogg',
      })
    );
    const [call] = s.api.of('sendGroupMedia');
    expect(call.args[2]).toMatchObject({
      kind: 'voice',
      caption: 'Ali (Agent)',
    });
    expect(s.store.messages[0]).toMatchObject({
      type: 'audio',
      body: '',
      prefixedBody: 'Ali (Agent)',
    });
  });

  it("keeps the prefixed caption within WhatsApp's 1024 characters", async () => {
    const s = setup();
    const g = await opened(s);
    await s.svc.sendMediaFromCrm(doc(g.id, { caption: 'x'.repeat(1024) }));
    const [call] = s.api.of('sendGroupMedia');
    const sent = (call.args[2] as { caption: string }).caption;
    expect(sent).toHaveLength(1024);
    expect(sent.startsWith('Ali (Agent): x')).toBe(true);
    expect(s.store.messages[0]).toMatchObject({ prefixedBody: sent });
  });

  it('consent refused: the row is settled blocked and nothing is sent', async () => {
    const s = setup();
    const g = await opened(s);
    s.consent.answer = { allowed: false, phone: '1', reason: 'opted_out' };
    await expect(s.svc.sendMediaFromCrm(doc(g.id))).rejects.toBeInstanceOf(
      SubmissionGroupSendBlockedError
    );
    expect(s.api.of('sendGroupMedia')).toEqual([]);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['blocked']);
  });

  it('a lost gateway answer is unconfirmed, a refusal keeps its own error', async () => {
    const send = async (err: Error) => {
      const s = setup();
      const g = await opened(s);
      s.api.sendGroupMedia = async () => {
        throw err;
      };
      const thrown = await s.svc.sendMediaFromCrm(doc(g.id)).catch((e) => e);
      expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['failed']);
      return thrown;
    };
    const lost = new WhapiError('timed out', 503);
    expect(await send(lost)).toBeInstanceOf(
      SubmissionGroupSendUnconfirmedError
    );
    const refused = new WhapiError('not allowed', 403);
    expect(await send(refused)).toBe(refused);
    const gone = new SubmissionGroupChannelError('ch-1');
    expect(await send(gone)).toBe(gone);
  });

  it('gateway error: the row is settled failed and the error reaches the caller', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupMedia');
    await expect(s.svc.sendMediaFromCrm(doc(g.id))).rejects.toThrow(
      /sendGroupMedia failed/
    );
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['failed']);
  });

  it('refused by the begin RPC: SEND_NOT_ALLOWED, nothing stored or sent', async () => {
    const s = setup();
    const g = await opened(s);
    await expect(
      s.svc.sendMediaFromCrm(doc(g.id, { userId: 'eve' }))
    ).rejects.toMatchObject({ reason: 'SEND_NOT_ALLOWED' });
    s.store.beginMediaSend = async () => null;
    await expect(s.svc.sendMediaFromCrm(doc(g.id))).rejects.toMatchObject({
      reason: 'SEND_NOT_ALLOWED',
    });
    expect(s.api.of('sendGroupMedia')).toEqual([]);
    expect(s.store.messages).toEqual([]);
  });
});

describe('SubmissionGroupService.sendFromCrm', () => {
  it('each listed person sends from the hosting number, prefixed with their name and access label', async () => {
    const s = setup();
    const g = await opened(s);
    for (const u of ['ali', 'noor', 'sara'])
      await s.svc.sendFromCrm({ groupId: g.id, userId: u, text: 'hi' });
    expect(s.api.of('sendGroupText').map((c) => c.args)).toEqual([
      [CH, g.waGroupId, 'Ali (Agent): hi'],
      [CH, g.waGroupId, 'Noor (Coordinator): hi'],
      [CH, g.waGroupId, 'Sara (Team Lead): hi'],
    ]);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual([
      'sent',
      'sent',
      'sent',
    ]);
  });

  it('refused: not on the list (an admin included), unknown user, ENDED; nothing stored or sent', async () => {
    const s = setup();
    const g = await opened(s);
    for (const u of ['eve', 'adam'])
      await expect(
        s.svc.sendFromCrm({ groupId: g.id, userId: u, text: 'x' })
      ).rejects.toMatchObject({ reason: 'SEND_NOT_ALLOWED' });
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ghost', text: 'x' })
    ).rejects.toMatchObject({ reason: 'UNKNOWN_USER' });
    await s.store.end(g.id, 'FINAL_STATUS:APPROVED');
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toBeInstanceOf(SubmissionGroupSendRefusedError);
    expect(s.api.of('sendGroupText')).toEqual([]);
    expect(s.store.messages).toEqual([]);
  });

  it('consent refused at send: the row is settled blocked and SubmissionGroupSendBlockedError names the reason', async () => {
    const s = setup();
    const g = await opened(s);
    s.consent.answer = { allowed: false, phone: '1', reason: 'opted_out' };
    const err = await s.svc
      .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSendBlockedError);
    expect((err as SubmissionGroupSendBlockedError).reason).toBe('opted_out');
    expect(s.api.of('sendGroupText')).toEqual([]);
    expect(s.store.messages.map((m) => [m.sendStatus, m.waMessageId])).toEqual([
      ['blocked', null],
    ]);
  });

  it.each(['get', 'openAccessLabel', 'beginSend'] as const)(
    '%s breaking before the row is stored: NotStored, nothing sent',
    async (method) => {
      const s = setup();
      const g = await opened(s);
      s.store[method] = async () => {
        throw new Error('db: connection reset');
      };
      const err = await s.svc
        .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionGroupSendNotStoredError);
      expect(s.store.messages).toEqual([]);
      expect(s.api.of('sendGroupText')).toEqual([]);
    }
  );

  it('gateway error: the row is settled failed and the error reaches the caller', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupText');
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toThrow(/sendGroupText failed/);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['failed']);
  });

  it("gateway error after the echo already settled the row sent: SentNotRecorded with the echo's id, never a failure to resend", async () => {
    const s = setup();
    const g = await opened(s);
    s.api.sendGroupText = async () => {
      const [m] = s.store.messages;
      expect(await s.store.settleSend(m.id, 'sent', 'wa-echo')).toBe(true);
      throw new Error('sendGroupText: response lost');
    };
    const err = await s.svc
      .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSentNotRecordedError);
    expect(err).toMatchObject({
      messageId: s.store.messages[0].id,
      waMessageId: 'wa-echo',
    });
    expect(s.store.messages.map((m) => [m.sendStatus, m.waMessageId])).toEqual([
      ['sent', 'wa-echo'],
    ]);
  });

  it('gateway error, the echo lands between the re-read and the failed settle: still SentNotRecorded', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupText');
    // The first read sees it pending; the echo settles it before 'failed'.
    const realState = s.store.sendState.bind(s.store);
    let reads = 0;
    s.store.sendState = async (mid) => {
      const state = await realState(mid);
      if (++reads === 1) {
        expect(await s.store.settleSend(mid, 'sent', 'wa-late')).toBe(true);
        return state; // still the pending snapshot taken before the echo
      }
      return state;
    };
    const err = await s.svc
      .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSentNotRecordedError);
    expect(err).toMatchObject({ waMessageId: 'wa-late' });
    expect(s.store.messages.map((m) => [m.sendStatus, m.waMessageId])).toEqual([
      ['sent', 'wa-late'],
    ]);
  });

  it('gateway error whose re-read fails: the row is settled failed and the gateway error reaches the caller', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupText');
    s.store.sendState = async () => {
      throw new Error('read: connection reset');
    };
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toThrow(/sendGroupText failed/);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['failed']);
  });

  /** Makes the next `n` settleSend(…, 'sent') calls throw before writing. */
  const failSentSettles = (store: FakeStore, n: number) => {
    const real = store.settleSend.bind(store);
    let left = n;
    store.settleSend = async (mid, status, wa) => {
      if (status === 'sent' && left > 0) {
        left--;
        throw new Error('settle: connection reset');
      }
      return real(mid, status, wa);
    };
  };

  it('a settle that throws after the gateway accepted is retried once and the send succeeds', async () => {
    const s = setup();
    const g = await opened(s);
    failSentSettles(s.store, 1);
    const out = await s.svc.sendFromCrm({
      groupId: g.id,
      userId: 'ali',
      text: 'x',
    });
    expect(s.api.of('sendGroupText')).toHaveLength(1);
    expect(s.store.messages.map((m) => [m.sendStatus, m.waMessageId])).toEqual([
      ['sent', out.waMessageId],
    ]);
  });

  it('a settle that fails twice is SubmissionGroupSentNotRecordedError naming both ids, sent once', async () => {
    const s = setup();
    const g = await opened(s);
    failSentSettles(s.store, 2);
    const err = await s.svc
      .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSentNotRecordedError);
    const [m] = s.store.messages;
    expect(err).toMatchObject({ messageId: m.id });
    expect(
      (err as SubmissionGroupSentNotRecordedError).waMessageId
    ).toBeTruthy();
    expect(s.api.of('sendGroupText')).toHaveLength(1);
    expect(m.sendStatus).toBe('pending');
  });

  it('a row no longer pending after the gateway accepted is SentNotRecorded too, never a plain failure', async () => {
    const s = setup();
    const g = await opened(s);
    s.store.settleSend = async () => false;
    const err = await s.svc
      .sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSentNotRecordedError);
    expect(s.api.of('sendGroupText')).toHaveLength(1);
  });
  /** Whapi's echo (inbound.ts) settles the row with `waOf(id)` before the sender's own settle runs. */
  const echoSettlesFirst = (
    s: ReturnType<typeof setup>,
    waOf: (id: string) => string = (id) => id
  ) => {
    const real = s.api.sendGroupText.bind(s.api);
    s.api.sendGroupText = async (ch, wa, text) => {
      const r = await real(ch, wa, text);
      const [m] = s.store.messages;
      expect(await s.store.settleSend(m.id, 'sent', waOf(r.waMessageId))).toBe(
        true
      );
      return r;
    };
  };

  it("the echo settled the row before the sender's own settle: a success, not SentNotRecorded", async () => {
    const s = setup();
    const g = await opened(s);
    echoSettlesFirst(s);
    const out = await s.svc.sendFromCrm({
      groupId: g.id,
      userId: 'ali',
      text: 'x',
    });
    expect(s.store.messages.map((m) => [m.sendStatus, m.waMessageId])).toEqual([
      ['sent', out.waMessageId],
    ]);
    expect(s.api.of('sendGroupText')).toHaveLength(1);
  });

  it('a row settled sent with a different WhatsApp id is still SentNotRecorded', async () => {
    const s = setup();
    const g = await opened(s);
    echoSettlesFirst(s, () => 'wa-other');
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toBeInstanceOf(SubmissionGroupSentNotRecordedError);
  });
});

describe('SubmissionGroupService.endIfDue / sweep / archive', () => {
  it('end during send: close deferred while the begun send is pending; it settles sent, then the next call closes once', async () => {
    const s = setup();
    const g = await opened(s);
    let during: unknown;
    s.api.hook = async () => {
      during = await s.svc.endIfDue(due(g.id));
    };
    await s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'last' });
    expect(during).toEqual({
      ended: true,
      reason: 'FINAL_STATUS:APPROVED',
      closed: false,
      closeError: null,
      closeDeferred: true,
    });
    expect(s.api.of('closeGroup')).toEqual([]);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['sent']);
    expect(await s.svc.endIfDue(due(g.id))).toMatchObject({ closed: true });
    await s.svc.endIfDue(due(g.id));
    expect(s.api.of('closeGroup').map((c) => c.args)).toEqual([
      [CH, g.waGroupId],
    ]);
  });

  it('gives up on people who cannot be removed a day after the close fell due', async () => {
    const t = { ms: Date.now() };
    const s = setup({ now: () => new Date(t.ms) });
    const g = await opened(s);
    s.api.fail.add('closeGroup');
    await s.svc.endIfDue(due(g.id));
    t.ms += CLOSE_GIVE_UP_MS - 60_000;
    s.api.fail.add('closeGroup');
    await s.svc.retryClose(g.id);
    t.ms += 5 * 60_000;
    expect(await s.svc.retryClose(g.id)).toMatchObject({ closed: true });
    expect(s.api.leaveAnyway).toEqual([false, false, true]);
  });

  it('close error recorded and retried by the next call', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('closeGroup');
    const first = await s.svc.endIfDue(due(g.id));
    expect(first).toMatchObject({ ended: true, closed: false });
    expect(first.closeError).toMatch(/closeGroup failed/);
    expect(s.store.groups.get(g.id)!.waCloseError).toMatch(/closeGroup/);
    expect(await s.svc.endIfDue(due(g.id))).toEqual({
      ended: false,
      reason: null,
      closed: true,
      closeError: null,
      closeDeferred: false,
    });
    expect(s.store.groups.get(g.id)!.waClosedAt).not.toBeNull();
  });

  it('endNow ends with the given reason and closes; on an ENDED group it only retries the close', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('closeGroup');
    const first = await s.svc.endNow(g.id, 'MANUAL');
    expect(first).toMatchObject({
      ended: true,
      reason: 'MANUAL',
      closed: false,
    });
    expect(s.store.groups.get(g.id)!).toMatchObject({
      status: 'ENDED',
      endReason: 'MANUAL',
    });
    expect(await s.svc.endNow(g.id, 'MANUAL')).toEqual({
      ended: false,
      reason: null,
      closed: true,
      closeError: null,
      closeDeferred: false,
    });
    expect(s.api.of('closeGroup')).toHaveLength(2);
  });

  it('retryClose closes an ENDED group once and never ends an ACTIVE one', async () => {
    const s = setup();
    const g = await opened(s);
    expect(await s.svc.retryClose(g.id)).toMatchObject({
      ended: false,
      closed: false,
    });
    expect(s.store.groups.get(g.id)!.status).toBe('ACTIVE');
    await s.store.end(g.id, 'MANUAL');
    expect(await s.svc.retryClose(g.id)).toMatchObject({ closed: true });
    await s.svc.retryClose(g.id);
    expect(s.api.of('closeGroup')).toHaveLength(1);
  });

  it('a disconnected number defers the close: not closed, no error recorded', async () => {
    const s = setup();
    const g = await opened(s);
    await s.store.end(g.id, 'MANUAL');
    const close = vi
      .spyOn(s.api, 'closeGroup')
      .mockRejectedValueOnce(new SubmissionGroupNumberDisconnectedError('w1'));
    expect(await s.svc.retryClose(g.id)).toMatchObject({
      closed: false,
      closeError: null,
      closeDeferred: true,
      numberDown: true,
    });
    const row = s.store.groups.get(g.id)!;
    expect([row.waClosedAt, row.waCloseError]).toEqual([null, null]);
    close.mockRestore();
    expect(await s.svc.retryClose(g.id)).toMatchObject({ closed: true });
  });

  it('a close says when it was the number that failed', async () => {
    const s = setup();
    const g = await opened(s);
    await s.store.end(g.id, 'MANUAL');
    const close = vi.spyOn(s.api, 'closeGroup');
    close.mockRejectedValueOnce(
      Object.assign(new Error('timed out'), { status: 503 })
    );
    expect((await s.svc.retryClose(g.id)).numberDown).toBe(true);
    close.mockRejectedValueOnce(
      Object.assign(new Error('not admin'), { status: 403 })
    );
    expect((await s.svc.retryClose(g.id)).numberDown).toBeUndefined();
  });

  it('not due: nothing ends', async () => {
    const s = setup();
    const g = await opened(s);
    expect(
      await s.svc.endIfDue({ ...due(g.id), status: 'IN_REVIEW' })
    ).toMatchObject({ ended: false, closed: false });
    expect(s.store.groups.get(g.id)!.status).toBe('ACTIVE');
  });

  it('stale pending swept to failed (a younger one is left), then the close proceeds', async () => {
    const s = setup();
    const g = await opened(s);
    const mid = await s.store.beginSend(g.id, 'ali', 'crashed', 'Ali: crashed');
    expect(await s.svc.endIfDue(due(g.id))).toMatchObject({
      closeDeferred: true,
    });
    const soon = new Date(Date.now() + 30_000);
    expect(
      await s.svc.sweepStalePending({ olderThanMs: 60_000, now: soon })
    ).toEqual({ failed: [] });
    const late = new Date(Date.now() + 61_000);
    expect(
      await s.svc.sweepStalePending({ olderThanMs: 60_000, now: late })
    ).toEqual({ failed: [mid] });
    expect(await s.svc.endIfDue(due(g.id))).toMatchObject({ closed: true });
  });

  it('archive: allowed views return messages and are audited; refused views are not', async () => {
    const s = setup();
    const g = await opened(s);
    await s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'docs' });
    expect(await s.svc.viewArchive({ groupId: g.id, userId: 'adam' })).toEqual({
      allowed: false,
    });
    await s.store.end(g.id, 'IDLE');
    expect(await s.svc.viewArchive({ groupId: g.id, userId: 'ali' })).toEqual({
      allowed: false,
    });
    const v = await s.svc.viewArchive({ groupId: g.id, userId: 'adam' });
    expect(v.allowed && v.messages.map((m) => m.prefixedBody)).toEqual([
      'Ali (Agent): docs',
    ]);
    const endedAt = s.store.groups.get(g.id)!.endedAt!.getTime();
    const day = (d: number) =>
      setup({ store: s.store, now: () => new Date(endedAt + d * DAY) });
    expect(
      (await day(59).svc.viewArchive({ groupId: g.id, userId: 'sara' })).allowed
    ).toBe(true);
    expect(
      (await day(61).svc.viewArchive({ groupId: g.id, userId: 'noor' })).allowed
    ).toBe(false);
    expect(s.store.audit.map((a) => a.userId)).toEqual(['adam', 'sara']);
  });

  it('a negative or fractional archive window is refused at construction', () => {
    for (const w of [-1, 1.5])
      expect(
        () =>
          new SubmissionGroupService({
            store: new FakeStore(),
            api: new FakeApi(),
            consent: async () => ({ allowed: true, phone: '1' }),
            displayName: async () => 'x',
            archiveSupervisorWindowDays: w,
          })
      ).toThrow(/windowDays/);
  });
});

describe('a group detached by 115 (its number or contact was deleted)', () => {
  const detach = (
    s: ReturnType<typeof setup>,
    id: string,
    patch: Partial<Pick<SubmissionGroup, 'channelId' | 'contactId'>>
  ) => s.store.groups.set(id, { ...s.store.groups.get(id)!, ...patch });

  it('send is refused before anything is stored: NUMBER_REMOVED, then CONTACT_REMOVED', async () => {
    const s = setup();
    const g = await opened(s);
    detach(s, g.id, { channelId: null });
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toMatchObject({ reason: 'NUMBER_REMOVED' });
    detach(s, g.id, { channelId: CH, contactId: null });
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toMatchObject({ reason: 'CONTACT_REMOVED' });
    expect(s.store.messages).toEqual([]);
    expect(s.api.of('sendGroupText')).toEqual([]);
  });

  it('a pending group without a number is not created and not claimed', async () => {
    const s = setup();
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow();
    const [g] = [...s.store.groups.values()];
    detach(s, g.id, { channelId: null });
    const r = await s.svc.retryOne(g.id);
    expect(r).toMatchObject({
      consentRequired: false,
      group: { waGroupId: null },
    });
    expect(s.api.of('createGroup')).toHaveLength(1);
    expect(s.store.claims.size).toBe(0);
  });

  it('an ENDED group without a number reports number_removed and records nothing', async () => {
    const s = setup();
    const g = await opened(s);
    detach(s, g.id, { channelId: null });
    const r = await s.svc.endIfDue(due(g.id));
    expect(r).toMatchObject({
      ended: true,
      closed: false,
      closeError: 'number_removed',
    });
    expect(s.api.of('closeGroup')).toEqual([]);
    expect(s.store.groups.get(g.id)!.waCloseError).toBeNull();
  });
});

describe('a submission without a WhatsApp group (136, waMode none)', () => {
  const openNone = (s: ReturnType<typeof setup>, ref = 'S-N') =>
    s.svc.openForSubmission({
      accountId: ACC,
      submissionRef: ref,
      contactId: 'c-1',
      channelId: null,
      waMode: 'none',
      subject: `Case ${ref}`,
      coordinatorPhone: '971500000009',
      access: ACCESS,
      keyId: null,
      customerName: null,
    });
  const openedNone = async (s: ReturnType<typeof setup>) => {
    const r = await openNone(s);
    if (r.consentRequired) throw new Error('unexpected consentRequired');
    return r.group;
  };

  it('opens the record only: no consent check, no gateway call, no invite', async () => {
    const s = setup();
    s.consent.answer = { allowed: false, phone: '1', reason: 'opted_out' };
    const r = await openNone(s);
    expect(r).toMatchObject({
      consentRequired: false,
      created: true,
      inviteLink: null,
      group: { waMode: 'none', channelId: null, waGroupId: null },
    });
    expect(r).toMatchObject({ refusedParticipants: [] });
    expect(s.consent.asked).toBe(0);
    expect(s.api.calls).toEqual([]);
    expect(s.store.claims.size).toBe(0);
    const again = await openNone(s);
    expect(again).toMatchObject({ created: false });
    expect(s.api.calls).toEqual([]);
  });

  it('retryOne leaves it alone', async () => {
    const s = setup();
    const g = await openedNone(s);
    const r = await s.svc.retryOne(g.id);
    expect(r).toMatchObject({ consentRequired: false, created: false });
    expect(s.api.calls).toEqual([]);
    expect(s.store.claims.size).toBe(0);
  });

  it('send is refused NO_WHATSAPP_GROUP before anything is stored', async () => {
    const s = setup();
    const g = await openedNone(s);
    const begin = vi.spyOn(s.store, 'beginSend');
    await expect(
      s.svc.sendFromCrm({ groupId: g.id, userId: 'ali', text: 'x' })
    ).rejects.toMatchObject({ reason: 'NO_WHATSAPP_GROUP' });
    expect(begin).not.toHaveBeenCalled();
    expect(s.store.messages).toEqual([]);
    expect(s.api.of('sendGroupText')).toEqual([]);
  });

  it('endIfDue ends it and never calls closeGroup', async () => {
    const s = setup();
    const g = await openedNone(s);
    const r = await s.svc.endIfDue(due(g.id));
    expect(r).toEqual({
      ended: true,
      reason: 'FINAL_STATUS:APPROVED',
      closed: false,
      closeError: null,
      closeDeferred: false,
    });
    expect(s.store.groups.get(g.id)!.status).toBe('ENDED');
    expect(s.api.of('closeGroup')).toEqual([]);
  });
});

describe('SubmissionGroupService.sendSystem (170)', () => {
  const welcome = (groupId: string) => ({
    groupId,
    kind: 'welcome' as const,
    key: 'welcome',
    text: 'Hello 👋',
  });

  it('stores the row, then sends the text unprefixed and settles it sent', async () => {
    const s = setup();
    const g = await opened(s);
    const asked = s.consent.asked;
    const r = await s.svc.sendSystem(welcome(g.id));
    expect(r).toEqual({
      status: 'sent',
      messageId: expect.any(String),
      waMessageId: expect.stringMatching(/^wamid-/),
    });
    expect(s.api.of('sendGroupText').map((c) => c.args)).toEqual([
      [CH, g.waGroupId, 'Hello 👋'],
    ]);
    expect(s.store.messages).toMatchObject([
      { senderUserId: null, systemKind: 'welcome', sendStatus: 'sent' },
    ]);
    expect(s.consent.asked).toBe(asked + 1);
  });

  it('a repeated key is a duplicate: nothing new stored or sent', async () => {
    const s = setup();
    const g = await opened(s);
    const first = await s.svc.sendSystem(welcome(g.id));
    const again = await s.svc.sendSystem(welcome(g.id));
    expect(again).toEqual({
      status: 'duplicate',
      messageId: first.status === 'sent' ? first.messageId : '',
      sendStatus: 'sent',
    });
    expect(s.api.of('sendGroupText')).toHaveLength(1);
    expect(s.store.messages).toHaveLength(1);
  });

  it('a refusal stores and sends nothing', async () => {
    const s = setup();
    const g = await opened(s);
    await s.svc.endNow(g.id, 'MANUAL');
    expect(await s.svc.sendSystem(welcome(g.id))).toEqual({
      status: 'refused',
      code: 'ENDED',
    });
    expect(s.api.of('sendGroupText')).toEqual([]);
    expect(s.store.messages).toEqual([]);
  });

  it('consent refused: the row is settled blocked and nothing is sent', async () => {
    const s = setup();
    const g = await opened(s);
    s.consent.answer = { allowed: false, phone: null, reason: 'opted_out' };
    expect(await s.svc.sendSystem(welcome(g.id))).toEqual({
      status: 'blocked',
      reason: 'opted_out',
    });
    expect(s.api.of('sendGroupText')).toEqual([]);
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['blocked']);
  });

  it('a gateway error settles the row failed and is rethrown', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupText');
    await expect(s.svc.sendSystem(welcome(g.id))).rejects.toThrow(
      /sendGroupText failed/
    );
    expect(s.store.messages.map((m) => m.sendStatus)).toEqual(['failed']);
  });

  it.each([
    ['a timeout', new WhapiError('timed out', 503)],
    ['a gateway 5xx', new WhapiError('bad gateway', 500)],
    ['a lost connection', new Error('socket hang up')],
  ])('%s may have gone out: Unconfirmed', async (_what, cause) => {
    const s = setup();
    const g = await opened(s);
    s.api.sendGroupText = async () => {
      throw cause;
    };
    const err = await s.svc.sendSystem(welcome(g.id)).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSendUnconfirmedError);
    expect(err).toMatchObject({ messageId: s.store.messages[0].id, cause });
  });

  it.each([
    ['a gateway 4xx', new WhapiError('not a member', 403)],
    ['a removed number', new SubmissionGroupChannelError('ch-1')],
    [
      'a number that could not be read',
      new SubmissionGroupNotAttemptedError(new Error('read failed')),
    ],
  ])('%s sent nothing: SystemNotSent', async (_what, cause) => {
    const s = setup();
    const g = await opened(s);
    s.api.sendGroupText = async () => {
      throw cause;
    };
    const err = await s.svc.sendSystem(welcome(g.id)).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionGroupSystemNotSentError);
    expect(err).toMatchObject({ messageId: s.store.messages[0].id, cause });
    expect(s.store.messages[0].sendStatus).toBe('failed');
  });

  it('a failed read, or a beforeGateway that throws, stops it before the gateway: SystemNotSent', async () => {
    const boom = new Error('read: connection reset');
    for (const how of ['get', 'consent', 'hook'] as const) {
      const s = setup();
      const g = await opened(s);
      if (how === 'get') {
        s.store.get = async () => {
          throw boom;
        };
      }
      if (how === 'consent') s.consent.error = boom;
      const err = await s.svc
        .sendSystem({
          ...welcome(g.id),
          beforeGateway: async () => {
            if (how === 'hook') throw boom;
          },
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(SubmissionGroupSystemNotSentError);
      expect(err).toMatchObject({
        messageId: s.store.messages[0].id,
        cause: boom,
      });
      expect(s.store.messages[0].sendStatus).toBe('failed');
      expect(s.api.of('sendGroupText')).toEqual([]);
    }
  });

  it('beforeGateway is told the stored message, before the gateway is called', async () => {
    const s = setup();
    const g = await opened(s);
    const seen: unknown[] = [];
    await s.svc.sendSystem({
      ...welcome(g.id),
      beforeGateway: async (id) => {
        seen.push(id, s.api.of('sendGroupText').length);
      },
    });
    expect(seen).toEqual([s.store.messages[0].id, 0]);
  });
});

describe('SubmissionGroupService.sendWelcomeIfDue (170)', () => {
  it('sends the welcome text once, keyed welcome', async () => {
    const s = setup();
    const g = await opened(s);
    const r = await s.svc.sendWelcomeIfDue(g.id);
    expect(r).toMatchObject({ status: 'sent' });
    expect(s.store.messages).toMatchObject([
      { systemKind: 'welcome', sendStatus: 'sent' },
    ]);
    expect(s.api.of('sendGroupText')[0].args[2]).toMatch(
      /^Hello 👋\n\nThis group is for your application with Taamul Credit\./
    );
    expect(await s.svc.sendWelcomeIfDue(g.id)).toMatchObject({
      status: 'duplicate',
    });
    expect(s.api.of('sendGroupText')).toHaveLength(1);
  });

  it('uses the welcomeDetails dep for the product and bank', async () => {
    const s = setup({
      welcomeDetails: async () => ({ product: 'Loan', bankName: 'ADCB' }),
    });
    const g = await opened(s);
    await s.svc.sendWelcomeIfDue(g.id);
    expect(s.api.of('sendGroupText')[0].args[2]).toContain(
      '*Loan* application with *ADCB*'
    );
  });

  it('returns null for an ENDED group, a none-mode group and one not ready', async () => {
    const s = setup();
    const ended = await opened(s, 'S-1');
    s.store.groups.get(ended.id)!.status = 'ENDED';
    const none = await opened(s, 'S-2');
    s.store.groups.get(none.id)!.waMode = 'none';
    const pending = await opened(s, 'S-3');
    s.store.groups.get(pending.id)!.waGroupId = null;
    for (const id of [ended.id, none.id, pending.id])
      expect(await s.svc.sendWelcomeIfDue(id)).toBeNull();
    expect(s.api.of('sendGroupText')).toEqual([]);
    expect(await s.svc.sendWelcomeIfDue('missing')).toBeNull();
  });

  it('swallows a failing send', async () => {
    const s = setup();
    const g = await opened(s);
    s.api.fail.add('sendGroupText');
    expect(await s.svc.sendWelcomeIfDue(g.id)).toBeNull();
  });
});

describe('the 2-day close hold (170)', () => {
  it('defers the WhatsApp close while the hold is in the future, closes once it has passed', async () => {
    let now = new Date('2026-11-03T10:00:00Z');
    const s = setup({ now: () => now });
    const g = await opened(s);
    s.store.holds.set(g.id, new Date('2026-11-05T10:00:00Z'));
    expect(await s.svc.endIfDue(due(g.id))).toEqual({
      ended: true,
      reason: 'FINAL_STATUS:APPROVED',
      closed: false,
      closeError: null,
      closeDeferred: true,
    });
    expect(await s.svc.retryClose(g.id)).toMatchObject({
      closed: false,
      closeDeferred: true,
    });
    expect(s.api.of('closeGroup')).toEqual([]);
    now = new Date('2026-11-05T10:00:01Z');
    expect(await s.svc.retryClose(g.id)).toMatchObject({ closed: true });
    expect(s.api.of('closeGroup')).toHaveLength(1);
  });

  it('an unreadable hold keeps the group open', async () => {
    const s = setup();
    const g = await opened(s);
    s.store.holds.set(g.id, () => {
      throw new Error('db down');
    });
    expect(await s.svc.endNow(g.id, 'CASE_FINAL')).toMatchObject({
      ended: true,
      closed: false,
      closeDeferred: true,
    });
    expect(s.api.of('closeGroup')).toEqual([]);
  });
});

describe('invite for a customer WhatsApp refused', () => {
  const PHONE = '971500000001';
  const LINK = 'https://chat.whatsapp.com/CODE1';
  const later = () => new Date(Date.now() + DAY);
  const refusing = (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup(o);
    s.api.refused = [PHONE];
    s.api.link = LINK;
    return s;
  };
  /** A group whose first createGroup failed, so it is pending. */
  const pending = async (s: ReturnType<typeof setup>) => {
    s.api.fail.add('createGroup');
    await expect(s.open()).rejects.toThrow('createGroup failed');
    return [...s.store.groups.values()][0];
  };

  it('sends once on a first create and answers the recorded group', async () => {
    const s = refusing();
    const r = await s.open();
    expect(s.api.of('sendInvite')).toEqual([
      { method: 'sendInvite', args: [CH, 'CODE1', PHONE] },
    ]);
    expect(s.store.invites).toEqual([
      { groupId: expect.any(String), sent: true, error: null },
    ]);
    expect(r).toMatchObject({
      inviteSent: true,
      refusedParticipants: [PHONE],
      group: { waGroupId: expect.any(String), inviteLink: LINK },
    });
    if (r.consentRequired) throw new Error('unexpected consentRequired');
    expect(r.group.inviteSentAt).toBeInstanceOf(Date);
  });

  it('matches a refused JID by its digits', async () => {
    const s = refusing();
    s.api.refused = [`${PHONE}@s.whatsapp.net`];
    await s.open();
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });

  it('sends nothing more on a repeat call', async () => {
    const s = refusing();
    await s.open();
    const again = await s.open();
    expect(again).toMatchObject({ inviteSent: false, refusedParticipants: [] });
    expect(s.api.of('sendInvite')).toHaveLength(1);
    expect(s.store.invites).toHaveLength(1);
  });

  it('invites from a group the cron created', async () => {
    const s = refusing({ now: later });
    const g = await pending(s);
    const input = { accountId: ACC, olderThanMs: 1000 };
    const r = await s.svc.retryPending(input);
    expect(r.created).toEqual([g.id]);
    expect(s.api.of('sendInvite')).toEqual([
      { method: 'sendInvite', args: [CH, 'CODE1', PHONE] },
    ]);
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: true, error: null },
    ]);
    await s.svc.retryPending(input);
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });

  it('invites from a group the admin retry created', async () => {
    const s = refusing();
    const g = await pending(s);
    const r = await s.svc.retryOne(g.id);
    expect(r).toMatchObject({ inviteSent: true, refusedParticipants: [PHONE] });
    expect(s.api.of('sendInvite')).toHaveLength(1);
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: true, error: null },
    ]);
    await expect(s.svc.retryOne(g.id)).resolves.toMatchObject({
      inviteSent: false,
    });
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });

  it('sends nothing when no one was refused', async () => {
    const s = setup();
    s.api.link = LINK;
    await expect(s.open()).resolves.toMatchObject({ inviteSent: false });
    expect(s.api.of('sendInvite')).toEqual([]);
    expect(s.store.invites).toEqual([]);
  });

  it('sends nothing when only a coordinator was refused', async () => {
    const s = refusing();
    s.api.refused = ['971500000009'];
    const r = await s.open('S-1', '971500000009');
    expect(r).toMatchObject({
      inviteSent: false,
      refusedParticipants: ['971500000009'],
    });
    expect(s.api.of('sendInvite')).toEqual([]);
    expect(s.store.invites).toEqual([]);
  });

  it('records a failed send and the create still succeeds', async () => {
    const s = refusing();
    s.api.inviteError = new Error('gateway down: secret');
    const r = await s.open();
    expect(r).toMatchObject({
      inviteSent: false,
      group: {
        waGroupId: expect.any(String),
        inviteSendError: 'The invite could not be sent',
      },
    });
    expect(s.store.invites).toEqual([
      {
        groupId: expect.any(String),
        sent: false,
        error: 'The invite could not be sent',
      },
    ]);
  });

  it('records a fixed category, never the gateway text, when WhatsApp refuses the invite', async () => {
    const s = refusing();
    s.api.inviteError = Object.assign(
      new Error('HTTP 403: token abc123 refused'),
      { status: 403 }
    );
    await s.open();
    expect(s.store.invites[0]).toMatchObject({
      sent: false,
      error: 'WhatsApp refused the invite',
    });
  });

  it('names a hosting number that is gone', async () => {
    const s = refusing();
    s.api.inviteError = new SubmissionGroupChannelError(CH);
    await s.open();
    expect(s.store.invites[0]).toMatchObject({
      sent: false,
      error: 'The hosting WhatsApp number is not available',
    });
  });

  it.each([null, 'https://evil.example/CODE1'])(
    'records the failure, and sends nothing, with no usable link (%s)',
    async (link) => {
      const s = refusing();
      s.api.link = link;
      await expect(s.open()).resolves.toMatchObject({ inviteSent: false });
      expect(s.api.of('sendInvite')).toEqual([]);
      expect(s.store.invites[0]).toMatchObject({
        sent: false,
        error: 'The group has no invite link',
      });
    }
  );

  it.each([
    [
      'withdrawn',
      () => ({ allowed: false, phone: PHONE, reason: 'opted_out' }),
      'The customer can no longer be contacted',
    ],
    [
      'unreadable',
      () => {
        throw new Error('db down');
      },
      'The invite could not be sent',
    ],
  ] as const)(
    'consent %s after createGroup: nothing is sent or recorded as sent',
    async (_n, after, reason) => {
      const s = refusing();
      const live: ConsentAnswer = { allowed: true, phone: PHONE };
      Object.defineProperty(s.consent, 'answer', {
        get: () => (s.api.of('createGroup').length ? after() : live),
      });
      const r = await s.open();
      expect(r).toMatchObject({ inviteSent: false });
      expect(s.api.of('sendInvite')).toEqual([]);
      expect(s.store.invites).toEqual([
        {
          groupId: expect.any(String),
          sent: false,
          error: reason,
        },
      ]);
    }
  );

  it('logs a failed record and still answers the send', async () => {
    const warn = vi.fn();
    const s = refusing({ logger: { warn } });
    s.store.noteInviteFails = true;
    const r = await s.open();
    expect(r).toMatchObject({
      inviteSent: true,
      group: { waGroupId: expect.any(String), inviteSentAt: null },
    });
    expect(warn).toHaveBeenCalledWith(
      'invite outcome could not be recorded',
      expect.objectContaining({ sent: true })
    );
  });

  it('never reaches an opted-out customer: the consent re-check stops the create', async () => {
    const s = refusing({ now: later });
    const g = await pending(s);
    s.api.calls = [];
    s.consent.answer = { allowed: false, phone: PHONE, reason: 'opted_out' };
    const r = await s.svc.retryPending({ accountId: ACC, olderThanMs: 1000 });
    expect(r.consentRequired).toEqual([g.id]);
    await expect(s.svc.retryOne(g.id)).resolves.toMatchObject({
      consentRequired: true,
    });
    expect(s.api.calls).toEqual([]);
    expect(s.store.invites).toEqual([]);
  });
});

describe('resendInvite', () => {
  const PHONE = '971500000001';
  const LINK = 'https://chat.whatsapp.com/CODE1';
  const NOW = new Date('2026-11-04T10:00:00Z');
  const MINUTE = 60_000;
  /** An open group with a WhatsApp group and no invite recorded. */
  const opened = async (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup({ now: () => NOW, ...o });
    s.store.claimNow = NOW;
    s.api.link = LINK;
    await s.open();
    s.api.calls = [];
    const g = [...s.store.groups.values()][0];
    return { s, g };
  };

  it('sends the stored link to the consent phone and answers the recorded group', async () => {
    const { s, g } = await opened();
    s.consent.answer = { allowed: true, phone: '971500000099' };
    const r = await s.svc.resendInvite(g.id);
    expect(s.api.calls).toEqual([
      { method: 'sendInvite', args: [CH, 'CODE1', '971500000099'] },
    ]);
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: true, error: null },
    ]);
    if (r.status !== 'sent') throw new Error('expected sent');
    expect(r.group.inviteSentAt).toBeInstanceOf(Date);
  });

  it.each([
    ['empty', null],
    ['unusable', 'https://example.com/CODE1'],
  ])(
    'fetches the link when the stored one is %s, and does not store it',
    async (_n, stored) => {
      const { s, g } = await opened();
      g.inviteLink = stored;
      await expect(s.svc.resendInvite(g.id)).resolves.toMatchObject({
        status: 'sent',
      });
      expect(s.api.calls).toEqual([
        { method: 'getInviteLink', args: [CH, g.waGroupId] },
        { method: 'sendInvite', args: [CH, 'FETCHED', PHONE] },
      ]);
      expect(s.store.groups.get(g.id)?.inviteLink).toBe(stored);
    }
  );

  it.each([
    ['not_active', { status: 'ENDED' }],
    ['no_whatsapp', { waMode: 'none' }],
    ['no_group_yet', { waGroupId: null }],
    ['detached', { channelId: null }],
    ['detached', { contactId: null }],
  ])(
    'refuses %s without asking consent or the gateway',
    async (code, patch) => {
      const { s, g } = await opened();
      Object.assign(g, patch);
      const asked = s.consent.asked;
      await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
        status: 'refused',
        code,
      });
      expect(s.consent.asked).toBe(asked);
      expect(s.api.calls).toEqual([]);
      expect(s.store.invites).toEqual([]);
    }
  );

  it('refuses a group that is gone', async () => {
    await expect(setup().svc.resendInvite('nope')).resolves.toEqual({
      status: 'refused',
      code: 'not_active',
    });
  });

  it.each(['opted_out', 'do_not_contact'] as const)(
    'sends nothing to a customer marked %s',
    async (reason) => {
      const { s, g } = await opened();
      s.consent.answer = { allowed: false, phone: PHONE, reason };
      await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
        status: 'refused',
        code: reason,
      });
      expect(s.api.calls).toEqual([]);
      expect(s.store.invites).toEqual([]);
    }
  );

  it('refuses a contact with no phone', async () => {
    const { s, g } = await opened();
    s.consent.answer = { allowed: false, phone: null };
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'refused',
      code: 'no_phone',
    });
    expect(s.api.calls).toEqual([]);
  });

  it('holds a resend for 10 minutes after the last invite went out', async () => {
    const { s, g } = await opened();
    g.inviteSentAt = new Date(NOW.getTime() - 10 * MINUTE + 1);
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'refused',
      code: 'too_soon',
    });
    expect(s.api.calls).toEqual([]);
    expect(s.store.invites).toEqual([]);

    g.inviteSentAt = new Date(NOW.getTime() - 10 * MINUTE);
    await expect(s.svc.resendInvite(g.id)).resolves.toMatchObject({
      status: 'sent',
    });
  });

  it('a failed attempt spends the window too: it may have reached the customer', async () => {
    const { s, g } = await opened();
    s.api.inviteError = new Error('down');
    await s.svc.resendInvite(g.id);
    s.api.inviteError = null;
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'refused',
      code: 'too_soon',
    });
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });

  it('asks for the 10-minute window just before the gateway, and not on a refusal', async () => {
    const { s, g } = await opened();
    s.consent.answer = { allowed: false, phone: PHONE, reason: 'opted_out' };
    await s.svc.resendInvite(g.id);
    expect(s.store.claimCalls).toEqual([]);
    s.consent.answer = { allowed: true, phone: PHONE };
    await s.svc.resendInvite(g.id);
    expect(s.store.claimCalls).toEqual([{ groupId: g.id, seconds: 600 }]);
  });

  it('two simultaneous resends send once', async () => {
    const { s, g } = await opened();
    const [a, b] = await Promise.all([
      s.svc.resendInvite(g.id),
      s.svc.resendInvite(g.id),
    ]);
    expect([a.status, b.status].sort()).toEqual(['refused', 'sent']);
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });

  it('refuses a customer already in the group, before consent and the gateway', async () => {
    const { s, g } = await opened();
    g.customerMembership = 'joined';
    const asked = s.consent.asked;
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'refused',
      code: 'already_joined',
    });
    expect(s.consent.asked).toBe(asked);
    expect(s.store.claimCalls).toEqual([]);
    expect(s.api.calls).toEqual([]);
  });

  it('records a refused send and answers its plain reason, never the raw error', async () => {
    const { s, g } = await opened();
    s.api.inviteError = Object.assign(new Error('token secret'), {
      status: 403,
    });
    const reason = 'WhatsApp refused the invite';
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'failed',
      reason,
    });
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: false, error: reason },
    ]);
  });

  it('a failed link fetch sends nothing and is recorded the same way', async () => {
    const { s, g } = await opened();
    g.inviteLink = null;
    s.api.fetchLinkError = new SubmissionGroupChannelError(CH);
    const reason = 'The hosting WhatsApp number is not available';
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'failed',
      reason,
    });
    expect(s.api.of('sendInvite')).toEqual([]);
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: false, error: reason },
    ]);
  });

  it('a fetched link that is no invite link sends nothing', async () => {
    const { s, g } = await opened();
    g.inviteLink = null;
    s.api.fetchedLink = 'https://example.com/x';
    const reason = 'The group has no invite link';
    await expect(s.svc.resendInvite(g.id)).resolves.toEqual({
      status: 'failed',
      reason,
    });
    expect(s.api.of('sendInvite')).toEqual([]);
    expect(s.store.invites).toEqual([
      { groupId: g.id, sent: false, error: reason },
    ]);
  });

  it('answers sent when only the record failed, since the send happened', async () => {
    const { s, g } = await opened();
    s.store.noteInviteFails = true;
    await expect(s.svc.resendInvite(g.id)).resolves.toMatchObject({
      status: 'sent',
      group: { id: g.id, inviteSentAt: null },
    });
    expect(s.api.of('sendInvite')).toHaveLength(1);
  });
});

describe('addNumber (211)', () => {
  it('adds through the gateway and settles added', async () => {
    const s = setup();
    const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
    expect(r).toEqual({ status: 'added' });
    expect(s.store.addBegun).toEqual([
      { groupId: 'g-1', userId: 'ali', phone: '971501234567' },
    ]);
    expect(s.api.calls).toEqual([
      {
        method: 'addParticipant',
        args: ['ch-x', 'wa-x@g.us', '971501234567'],
      },
    ]);
    expect(s.store.addSettles).toEqual([
      { id: 'add-1', status: 'added', error: null },
    ]);
  });

  it('answers a refusal from SQL without calling the gateway', async () => {
    const s = setup();
    s.store.addBegin = { ok: false, code: 'opted_out' };
    const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
    expect(r).toEqual({ status: 'not_allowed', code: 'opted_out' });
    expect(s.api.calls).toEqual([]);
    expect(s.store.addSettles).toEqual([]);
  });

  it('hands back the stored invite link when WhatsApp refuses, sending nothing', async () => {
    const s = setup();
    s.store.addBegin = {
      ok: true,
      id: 'add-1',
      channelId: 'ch-x',
      waGroupId: 'wa-x@g.us',
      inviteLink: 'https://chat.whatsapp.com/STORED',
    };
    s.api.addOutcome = 'refused';
    const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
    expect(r).toEqual({
      status: 'refused',
      inviteLink: 'https://chat.whatsapp.com/STORED',
    });
    expect(s.store.addSettles[0].status).toBe('refused');
    expect(s.api.calls.map((c) => c.method)).toEqual(['addParticipant']);
  });

  it('fetches the link when none is stored, and survives that failing', async () => {
    const s = setup();
    s.api.addOutcome = 'refused';
    expect(await s.svc.addNumber('g-1', 'ali', '971501234567')).toEqual({
      status: 'refused',
      inviteLink: s.api.fetchedLink,
    });
    s.api.fetchLinkError = new Error('down');
    expect(await s.svc.addNumber('g-1', 'ali', '971501234567')).toEqual({
      status: 'refused',
      inviteLink: null,
    });
  });

  it('settles failed when the gateway throws, and still answers if the settle fails', async () => {
    const s = setup();
    s.api.addError = new Error('timeout');
    const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
    // It may be in the group: never worded as "try again".
    expect(r).toEqual({ status: 'unconfirmed' });
    expect(s.store.addSettles).toEqual([
      { id: 'add-1', status: 'failed', error: 'timeout' },
    ]);
    s.store.addSettleFails = true;
    s.api.addError = null;
    expect(await s.svc.addNumber('g-1', 'ali', '971501234567')).toEqual({
      status: 'added',
    });
  });

  it('is failed only when the number was certainly not added', async () => {
    const s = setup();
    for (const err of [
      new SubmissionGroupNotAttemptedError(new Error('not_admin')),
      new WhapiError('no', 403),
      new SubmissionGroupChannelError(CH),
    ]) {
      s.api.addError = err;
      const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
      expect(r.status).toBe('failed');
    }
  });

  it('tells the staff-number hook which group and phone were added', async () => {
    const joined = vi.fn().mockResolvedValue(undefined);
    const s = setup({ staffNumberJoined: joined });
    expect(await s.svc.addNumber('g-1', 'ali', '971501234567')).toEqual({
      status: 'added',
    });
    expect(joined).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenCalledWith('g-1', '971501234567');
  });

  it('still answers added when the staff-number hook throws', async () => {
    const joined = vi.fn().mockRejectedValue(new Error('grant failed'));
    const s = setup({ staffNumberJoined: joined });
    expect(await s.svc.addNumber('g-1', 'ali', '971501234567')).toEqual({
      status: 'added',
    });
    expect(joined).toHaveBeenCalledTimes(1);
  });

  it('does not call the staff-number hook when the add is refused', async () => {
    const joined = vi.fn();
    const s = setup({ staffNumberJoined: joined });
    s.api.addOutcome = 'refused';
    const r = await s.svc.addNumber('g-1', 'ali', '971501234567');
    expect(r.status).toBe('refused');
    expect(joined).not.toHaveBeenCalled();
  });
});
