import { describe, expect, it, vi } from 'vitest';

import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
} from '@/lib/submission-groups/service';

import { CaseConversations, CaseTakeOverRefusedError } from './conversations';
import { HANDOVER_TEMPLATE_DRAFT, type HandoverTemplate } from './handover';
import { CaseRefusedError } from './store';
import type { CaseRole } from './types';
import {
  ACTOR,
  CASE_ID,
  FakeClient,
  GROUP_ID,
  fakeStore,
  groupRow,
  messageRow,
  type Result,
} from './read-fakes';

const APPROVED: HandoverTemplate = {
  version: 'v1',
  status: 'APPROVED',
  text: 'Hi, {agentName} here for {bankName}.',
};
const NAMES = { agentName: 'Sara $1', bankName: 'ADCB' };

function setup(
  opts: {
    status?: 'ACTIVE' | 'ENDED';
    readable?: boolean;
    role?: CaseRole | null;
    liveThrows?: boolean;
    takeover?: Result;
    send?: () => Promise<unknown>;
    handover?: { template: HandoverTemplate; allowDraftTemplate?: boolean };
  } = {}
) {
  const log: string[] = [];
  const db = new FakeClient(
    'db',
    log,
    { case_takeover_record: () => opts.takeover ?? { data: 7 } },
    {
      submission_groups: () => ({ data: groupRow(opts.status ?? 'ACTIVE') }),
      submission_group_messages: () => {
        if (opts.liveThrows) throw new Error('live source down');
        return { data: [messageRow('m1', '2026-10-02T09:00:00Z')] };
      },
    }
  );
  const { store, calls } = fakeStore(log, {
    readable: opts.readable,
    role: opts.role,
  });
  const archive = { allowed: true as const, messages: [] };
  const groups = {
    sendFromCrm: vi.fn(async (input: { text: string }) => {
      log.push('groups.sendFromCrm');
      if (opts.send) await opts.send();
      return {
        messageId: 'msg-1',
        prefixedBody: `X: ${input.text}`,
        waMessageId: 'wa-1',
      };
    }),
    viewArchive: vi.fn(async () => {
      log.push('groups.viewArchive');
      return archive;
    }),
  };
  const conv = new CaseConversations({
    db: db.client,
    store,
    groups,
    ...(opts.handover ? { handover: opts.handover } : {}),
  });
  return { log, db, calls, groups, conv };
}

describe('CaseConversations.read', () => {
  it('calls view_case before any message read', async () => {
    const { log, db, conv } = setup();
    const r = await conv.read(ACTOR, CASE_ID);
    expect(r).toMatchObject({
      allowed: true,
      archived: false,
      groupId: GROUP_ID,
    });
    expect(log[0]).toBe('store.viewCases');
    expect(db.queriesOf('submission_group_messages')[0].filters).toContainEqual(
      ['eq', 'post_end', false]
    );
  });

  it('view_case has run even when the live read throws', async () => {
    const { log, calls, conv } = setup({ liveThrows: true });
    await expect(conv.read(ACTOR, CASE_ID)).rejects.toThrow('live source down');
    expect(calls.filter((c) => c.fn === 'viewCases')).toEqual([
      { fn: 'viewCases', args: [ACTOR, [CASE_ID]] },
    ]);
    expect(log.indexOf('store.viewCases')).toBeLessThan(
      log.indexOf('db.from:submission_group_messages')
    );
  });

  it('an agent’s read goes through view_case too (the SQL decides not to audit it)', async () => {
    const { calls, conv } = setup({ role: 'agent' });
    await conv.read(ACTOR, CASE_ID);
    expect(calls.map((c) => c.fn)).toContain('viewCases');
    expect(calls.map((c) => c.fn)).not.toContain('role');
  });

  it('not readable: { allowed: false } and nothing else is read', async () => {
    const { db, groups, conv } = setup({ readable: false });
    expect(await conv.read(ACTOR, CASE_ID)).toEqual({ allowed: false });
    expect(db.queries).toHaveLength(0);
    expect(groups.viewArchive).not.toHaveBeenCalled();
  });

  it('ENDED: viewArchive with { groupId, userId } only, no role and no live read', async () => {
    const { db, calls, groups, conv } = setup({ status: 'ENDED' });
    const r = await conv.read(ACTOR, CASE_ID);
    expect(r).toMatchObject({ allowed: true, archived: true });
    expect(groups.viewArchive).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      userId: ACTOR,
    });
    expect(calls.map((c) => c.fn)).not.toContain('role');
    expect(db.queriesOf('submission_group_messages')).toHaveLength(0);
  });

  it('ENDED and the archive refuses: allowed false', async () => {
    const { groups, conv } = setup({ status: 'ENDED' });
    groups.viewArchive.mockResolvedValueOnce({ allowed: false } as never);
    expect(await conv.read(ACTOR, CASE_ID)).toEqual({ allowed: false });
  });
});

describe('CaseConversations.reply', () => {
  it('a non-writer is refused before any send', async () => {
    const { groups, conv } = setup({ role: null });
    await expect(conv.reply(ACTOR, CASE_ID, 'hi')).rejects.toBeInstanceOf(
      CaseRefusedError
    );
    expect(groups.sendFromCrm).not.toHaveBeenCalled();
  });

  it('a writer sends through sendFromCrm into the case’s group', async () => {
    const { groups, conv } = setup({ role: 'coordinator' });
    await conv.reply(ACTOR, CASE_ID, 'hi');
    expect(groups.sendFromCrm).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      userId: ACTOR,
      text: 'hi',
    });
  });

  it('send errors pass through typed', async () => {
    const { conv } = setup({
      role: 'agent',
      send: async () => {
        throw new SubmissionGroupSendBlockedError('opted_out');
      },
    });
    await expect(conv.reply(ACTOR, CASE_ID, 'hi')).rejects.toBeInstanceOf(
      SubmissionGroupSendBlockedError
    );
  });
});

describe('CaseConversations.takeOver', () => {
  it('TEMPLATE_NOT_APPROVED by default (the draft): nothing logged or sent', async () => {
    const { db, groups, conv } = setup();
    const err = await conv.takeOver(ACTOR, CASE_ID, NAMES).catch((e) => e);
    expect(err).toBeInstanceOf(CaseTakeOverRefusedError);
    expect(err.reason).toBe('TEMPLATE_NOT_APPROVED');
    expect(db.rpcs).toHaveLength(0);
    expect(groups.sendFromCrm).not.toHaveBeenCalled();
  });

  it.each([
    [{ agentName: '  ', bankName: 'ADCB' }, APPROVED, 'NAME_INVALID'],
    [
      { agentName: 'x'.repeat(101), bankName: 'ADCB' },
      APPROVED,
      'NAME_INVALID',
    ],
    [NAMES, { ...APPROVED, version: ' \n ' }, 'TEMPLATE_INVALID'],
    [NAMES, { ...APPROVED, version: 'v'.repeat(41) }, 'TEMPLATE_INVALID'],
    [NAMES, { ...APPROVED, text: '\t' }, 'TEMPLATE_INVALID'],
  ])(
    '%j / %j -> %s before anything is logged',
    async (names, template, reason) => {
      const { db, groups, conv } = setup({ handover: { template } });
      await expect(conv.takeOver(ACTOR, CASE_ID, names)).rejects.toMatchObject({
        reason,
      });
      expect(db.rpcs).toHaveLength(0);
      expect(groups.sendFromCrm).not.toHaveBeenCalled();
    }
  );

  it('agent / admin: the SQL refuses NOT_ALLOWED and nothing is sent', async () => {
    const { groups, conv } = setup({
      handover: { template: APPROVED },
      takeover: { error: { message: 'x', code: '42501', hint: 'NOT_ALLOWED' } },
    });
    await expect(conv.takeOver(ACTOR, CASE_ID, NAMES)).rejects.toMatchObject({
      reason: 'NOT_ALLOWED',
    });
    expect(groups.sendFromCrm).not.toHaveBeenCalled();
  });

  it('records before it sends, with the rendered text and the normalised version', async () => {
    const { log, db, groups, conv } = setup({
      handover: { template: { ...APPROVED, version: ' v1 ' } },
    });
    const r = await conv.takeOver(ACTOR, CASE_ID, NAMES);
    expect(log.indexOf('db.rpc:case_takeover_record')).toBeLessThan(
      log.indexOf('groups.sendFromCrm')
    );
    expect(db.rpcs[0].args).toEqual({
      p_actor: ACTOR,
      p_case: CASE_ID,
      p_template_version: 'v1',
    });
    expect(groups.sendFromCrm).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      userId: ACTOR,
      text: 'Hi, Sara $1 here for ADCB.',
    });
    expect(r).toMatchObject({
      logId: '7',
      templateVersion: 'v1',
      messageId: 'msg-1',
    });
  });

  it('the draft is usable with allowDraftTemplate', async () => {
    const { groups, conv } = setup({
      handover: { template: HANDOVER_TEMPLATE_DRAFT, allowDraftTemplate: true },
    });
    await conv.takeOver(ACTOR, CASE_ID, NAMES);
    expect(groups.sendFromCrm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['blocked', () => new SubmissionGroupSendBlockedError('opted_out')],
    ['refused', () => new SubmissionGroupSendRefusedError('SEND_NOT_ALLOWED')],
  ])(
    'logged then %s: the error passes through and the log row stays',
    async (_k, mk) => {
      const { db, conv } = setup({
        handover: { template: APPROVED },
        send: async () => {
          throw mk();
        },
      });
      await expect(conv.takeOver(ACTOR, CASE_ID, NAMES)).rejects.toBeInstanceOf(
        mk().constructor
      );
      expect(db.rpcs.map((r) => r.fn)).toEqual(['case_takeover_record']);
    }
  );
});
