import { describe, expect, it } from 'vitest';

import type { StaffLabel } from './rules';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
  SubmissionGroupService,
  type GroupStore,
  type GroupsApi,
} from './service';
import type {
  ConsentAnswer,
  GroupMessage,
  SendStatus,
  SubmissionGroup,
} from './store';

const ACC = 'acc-1';
const CH = 'ch-1';
const DAY = 86_400_000;

/** In-memory stand-in for the sg_* RPCs (the SQL itself is asserted by verify-submission-groups.sql). */
class FakeStore implements GroupStore {
  groups = new Map<string, SubmissionGroup>();
  claims = new Map<string, { token: string; until: number }>();
  access: {
    groupId: string;
    userId: string;
    label: StaffLabel;
    removed: boolean;
  }[] = [];
  messages: (GroupMessage & { groupId: string })[] = [];
  admins = new Set(['adam']);
  audit: { groupId: string; userId: string }[] = [];
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
    return g ? { ...g } : null;
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
    this.groups.get(id)!.waCreateError = error;
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
  private seq = 0;
  private maybeFail(m: string) {
    if (this.fail.delete(m)) throw new Error(`${m} failed`);
  }
  async createGroup(ch: string, parts: string[], subject: string, key: string) {
    this.calls.push({ method: 'createGroup', args: [ch, parts, subject, key] });
    if (this.hook) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    this.maybeFail('createGroup');
    const wa = this.byKey.get(key) ?? `wag-${++this.seq}@g.us`;
    this.byKey.set(key, wa);
    return { waGroupId: wa, inviteLink: `https://chat.whatsapp.com/${wa}` };
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
  async closeGroup(ch: string, wa: string) {
    this.calls.push({ method: 'closeGroup', args: [ch, wa] });
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

function setup(o: { now?: () => Date; store?: FakeStore; api?: FakeApi } = {}) {
  const store = o.store ?? new FakeStore();
  const api = o.api ?? new FakeApi();
  const consent: { answer: ConsentAnswer; asked: number } = {
    answer: { allowed: true, phone: '971500000001' },
    asked: 0,
  };
  const svc = new SubmissionGroupService({
    store,
    api,
    consent: async () => {
      consent.asked++;
      return consent.answer;
    },
    displayName: async (u) => NAMES[u] ?? null,
    logger: { warn: () => {} },
    ...(o.now ? { now: o.now } : {}),
  });
  const open = (ref = 'S-1', coordinatorPhone: string | null = null) =>
    svc.openForSubmission({
      accountId: ACC,
      submissionRef: ref,
      contactId: 'c-1',
      channelId: CH,
      subject: `Case ${ref}`,
      coordinatorPhone,
      access: ACCESS,
      keyId: null,
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

  it('orphan: a lost claim on a still-pending row closes our group (no idempotency key; the cron recreates)', async () => {
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
    expect(s.api.of('closeGroup').map((c) => c.args)).toEqual([
      [CH, expect.any(String)],
    ]);
    expect(r).toMatchObject({ group: { waGroupId: null } });
  });

  it('orphan: an attach that throws on a still-pending row closes our group', async () => {
    const s = setup();
    s.store.attachWaGroup = async () => {
      throw new Error('attach: connection reset');
    };
    await expect(s.open()).rejects.toThrow(/attach/);
    const [g] = [...s.store.groups.values()];
    expect(g.waGroupId).toBeNull();
    expect(s.api.of('closeGroup')).toHaveLength(1);
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
