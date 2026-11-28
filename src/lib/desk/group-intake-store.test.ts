import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DeskGroupIntakeStore,
  GROUP_IDS_MAX,
  GROUP_INTAKE_OUTCOMES,
  GROUP_REPLY_STATES,
} from './group-intake-store';
import { DESK_REFUSAL_HTTP } from './http';
import { DESK_REFUSALS, DeskRefusedError } from './store';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/334_desk_group_intake.sql'),
  'utf8'
);

/** The quoted words of the CHECK named `name`. */
function checkWords(name: string): string[] {
  const at = SQL.indexOf(`CONSTRAINT ${name}`);
  expect(at).toBeGreaterThan(-1);
  const body = SQL.slice(at, SQL.indexOf('),', at) + 1);
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('migration 334', () => {
  it('raises only hints the desk knows, each with a status', () => {
    const hints = new Set(
      [...SQL.matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map((m) => m[1])
    );
    expect([...hints].sort()).toEqual([
      'BANK_NOT_FOUND',
      'GROUP_ALREADY_LINKED',
      'GROUP_NOT_FOUND',
      'INVALID',
      'NOT_ALLOWED',
      'NOT_LINKED',
    ]);
    for (const h of hints) {
      expect(DESK_REFUSALS).toContain(h);
      expect(
        DESK_REFUSAL_HTTP[h as keyof typeof DESK_REFUSAL_HTTP].status
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it('pins the outcome and reply-state lists to their CHECKs', () => {
    expect(checkWords('desk_group_intake_outcome_check')).toEqual([
      ...GROUP_INTAKE_OUTCOMES,
    ]);
    expect(checkWords('desk_group_intake_reply_state_check')).toEqual([
      ...GROUP_REPLY_STATES,
    ]);
  });

  it('caps the id lists where the SQL does', () => {
    expect(SQL).toContain(`cardinality(p_message_ids), 0) > ${GROUP_IDS_MAX}`);
    expect(SQL).toContain(`cardinality(p_group_ids), 0) > ${GROUP_IDS_MAX}`);
  });
});

function storeAnswering(answer: { data?: unknown; error?: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  };
  const store = new DeskGroupIntakeStore(
    db as never,
    () => new Date('2026-11-28T08:00:00Z')
  );
  return { store, calls };
}

describe('DeskGroupIntakeStore', () => {
  it('links and unlinks with the actor, active account and clock', async () => {
    const { store, calls } = storeAnswering({});
    await store.setLink('u1', 'acc1', 'g1', {
      bankCode: 'RAK',
      intakeEnabled: true,
      repliesEnabled: false,
    });
    await store.setLink('u1', 'acc1', 'g1', null);
    expect(calls.map((c) => c.fn)).toEqual([
      'desk_group_link_set',
      'desk_group_link_set',
    ]);
    expect(calls[0].args).toEqual({
      p_actor: 'u1',
      p_account: 'acc1',
      p_group: 'g1',
      p_bank_code: 'RAK',
      p_intake: true,
      p_replies: false,
      p_now: '2026-11-28T08:00:00.000Z',
    });
    expect(calls[1].args).toMatchObject({
      p_bank_code: null,
      p_intake: null,
      p_replies: null,
    });
  });

  it("reads one group's link with no actor; none is null", async () => {
    const linked = storeAnswering({
      data: [
        {
          bank_code: 'RAK',
          intake_enabled: true,
          replies_enabled: false,
          bank_name: 'RAKBANK',
        },
      ],
    });
    expect(await linked.store.linkForGroup('acc1', 'g1')).toEqual({
      bankCode: 'RAK',
      bankName: 'RAKBANK',
      intakeEnabled: true,
      repliesEnabled: false,
    });
    expect(linked.calls).toEqual([
      {
        fn: 'desk_group_link_for_group',
        args: { p_account: 'acc1', p_group: 'g1' },
      },
    ]);
    // unlinked and a submission group's mirror both answer no row
    expect(
      await storeAnswering({ data: [] }).store.linkForGroup('acc1', 'g2')
    ).toBeNull();
  });

  it('pins desk_group_link_for_group to the service role, no actor', () => {
    const at = SQL.indexOf('FUNCTION public.desk_group_link_for_group(');
    expect(at).toBeGreaterThan(-1);
    expect(SQL.slice(at, at + 120)).toContain('(p_account uuid, p_group uuid)');
    const grant = SQL.slice(SQL.lastIndexOf('GRANT EXECUTE'));
    expect(grant).toContain('public.desk_group_link_for_group(uuid, uuid)');
    expect(grant).toContain('TO service_role;');
  });

  it('throws a NOT_LINKED refusal as DeskRefusedError', async () => {
    const { store } = storeAnswering({
      error: { code: '23514', hint: 'NOT_LINKED' },
    });
    await expect(
      store.record('acc1', {
        groupMessageId: 'm1',
        outcome: 'filed',
        intakeItemId: null,
        detail: null,
      })
    ).rejects.toEqual(new DeskRefusedError('NOT_LINKED'));
  });

  it('reads scalar answers: staff, stored outcome, claim', async () => {
    expect(
      await storeAnswering({ data: 'user-1' }).store.staffForPhone(
        'acc1',
        '971500000001'
      )
    ).toBe('user-1');
    expect(
      await storeAnswering({ data: null }).store.staffForPhone('acc1', '9715')
    ).toBeNull();
    const rec = storeAnswering({ data: 'queued' });
    expect(
      await rec.store.record('acc1', {
        groupMessageId: 'm1',
        outcome: 'filed',
        intakeItemId: 'i1',
        detail: 'NO_CASE_REF',
      })
    ).toBe('queued');
    expect(rec.calls[0].args).toMatchObject({
      p_group_message_id: 'm1',
      p_outcome: 'filed',
      p_intake_item_id: 'i1',
      p_detail: 'NO_CASE_REF',
    });
    expect(
      await storeAnswering({ data: true }).store.claimReply('acc1', 'm1')
    ).toBe(true);
    expect(
      await storeAnswering({ data: false }).store.claimReply('acc1', 'm1')
    ).toBe(false);
  });

  it('never sends a reply id for a failed reply', async () => {
    const { store, calls } = storeAnswering({ data: true });
    expect(await store.settleReply('acc1', 'm1', false, 'wamid.1')).toBe(true);
    expect(calls[0].args).toMatchObject({
      p_ok: false,
      p_reply_message_id: null,
    });
  });

  it('parses wall rows and outcomes', async () => {
    const wall = storeAnswering({
      data: [
        {
          group_id: 'g1',
          bank_code: 'RAK',
          bank_name: 'RAKBANK',
          short_code: 'RAK',
          primary_name: 'Asha',
          second_name: null,
          filed_today: '3',
          to_sort: 2,
          oldest_age_seconds: '7260',
          alert: 'second',
        },
      ],
    });
    expect(await wall.store.wall('u1', 'acc1', ['g1'])).toEqual([
      {
        groupId: 'g1',
        bankCode: 'RAK',
        bankName: 'RAKBANK',
        shortCode: 'RAK',
        primaryName: 'Asha',
        secondName: null,
        filedToday: 3,
        toSort: 2,
        oldestAgeSeconds: 7260,
        alert: 'second',
      },
    ]);
    expect(wall.calls[0].args).toMatchObject({
      p_group_ids: ['g1'],
      p_now: '2026-11-28T08:00:00.000Z',
    });
    const out = storeAnswering({
      data: [
        {
          group_message_id: 'm1',
          outcome: 'queued',
          detail: 'NO_CASE_REF',
          reply_state: 'sent',
          item_state: 'filed',
          case_number: 'TC-26-00001-RAK',
          caption_code: '1RAK7',
          doc_key: 'passport',
          queue_reason: null,
        },
      ],
    });
    expect(await out.store.outcomes('u1', 'acc1', ['m1'])).toEqual([
      {
        groupMessageId: 'm1',
        outcome: 'queued',
        detail: 'NO_CASE_REF',
        replyState: 'sent',
        itemState: 'filed',
        caseNumber: 'TC-26-00001-RAK',
        captionCode: '1RAK7',
        docKey: 'passport',
        queueReason: null,
      },
    ]);
  });

  it('asks nothing for an empty id list', async () => {
    const { store, calls } = storeAnswering({ data: [] });
    expect(await store.wall('u1', 'acc1', [])).toEqual([]);
    expect(await store.outcomes('u1', 'acc1', [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
