import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from './channels';
import {
  GROUP_ADD_POLICY,
  GroupsUnsupportedError,
  addParticipants,
  callTimeoutMs,
  createGroup,
  describeGroupFailure,
  normaliseParticipants,
  ourRoleIn,
  planParticipantBatches,
  sendGroupText,
  toParticipantWaId,
} from './groups';
import { WhapiError } from './whapi-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GID = '120363025555555555@g.us';
const whapiChannel = {
  id: 'c1',
  provider: 'whapi',
  accessToken: 'tok',
} as WhatsAppChannel;
const metaChannel = {
  id: 'c2',
  provider: 'meta',
  accessToken: 'tok',
} as WhatsAppChannel;

const phones = (n: number) =>
  Array.from({ length: n }, (_, i) => `9715000${String(i).padStart(5, '0')}`);

function bodyOf(i: number) {
  return JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);
}

describe('toParticipantWaId', () => {
  it('normalises the forms people type', () => {
    expect(toParticipantWaId('+971 50 123 4567')).toBe('971501234567');
    expect(toParticipantWaId('00971501234567')).toBe('971501234567');
    expect(toParticipantWaId('971501234567@s.whatsapp.net')).toBe(
      '971501234567'
    );
    expect(toParticipantWaId('0501234567')).toBeNull();
    expect(toParticipantWaId('12')).toBeNull();
    expect(toParticipantWaId(GID)).toBeNull();
  });

  it('dedupes and separates invalid input', () => {
    expect(
      normaliseParticipants(['+971501234567', '971501234567', 'abc'])
    ).toEqual({ waIds: ['971501234567'], invalid: ['abc'] });
  });
});

describe('planParticipantBatches', () => {
  it('splits into batches of the policy size and caps the operation', () => {
    const plan = planParticipantBatches(phones(53));
    expect(plan.batches).toHaveLength(10);
    expect(
      plan.batches.every((b) => b.length === GROUP_ADD_POLICY.batchSize)
    ).toBe(true);
    expect(plan.overflow).toEqual(phones(53).slice(50));
  });

  it('keeps a short tail batch', () => {
    expect(
      planParticipantBatches(phones(7), { batchSize: 5 }).batches.map(
        (b) => b.length
      )
    ).toEqual([5, 2]);
  });
});

describe('addParticipants', () => {
  it('adds in paced batches and reports refused and over-cap people', async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      const { participants } = JSON.parse(init.body as string);
      return json({
        success: true,
        processed: participants.slice(1),
        failed: participants.slice(0, 1),
      });
    });
    const sleep = vi.fn(async () => {});
    const res = await addParticipants({
      channel: whapiChannel,
      groupId: GID,
      participants: [...phones(52), 'junk'],
      sleep,
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    for (let i = 0; i < 10; i++) expect(bodyOf(i).participants).toHaveLength(5);
    expect(sleep).toHaveBeenCalledTimes(9);
    expect(sleep).toHaveBeenCalledWith(GROUP_ADD_POLICY.pauseMs);
    expect(res.added).toHaveLength(40);
    expect(res.refused).toHaveLength(10);
    expect(res.notAttempted).toEqual(phones(52).slice(50));
    expect(res.invalid).toEqual(['junk']);
    expect(res.error).toBeNull();
  });

  it('stops at the first failed batch and lists the rest as not attempted', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ processed: phones(5), failed: [] }))
      .mockResolvedValueOnce(json({ error: { message: 'slow down' } }, 429));
    const res = await addParticipants({
      channel: whapiChannel,
      groupId: GID,
      participants: phones(12),
      sleep: async () => {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.error).toBe('rate_limited');
    expect(res.added).toHaveLength(5);
    expect(res.notAttempted).toEqual(phones(12).slice(5));
  });

  it('refuses a Meta channel', async () => {
    await expect(
      addParticipants({
        channel: metaChannel,
        groupId: GID,
        participants: phones(1),
      })
    ).rejects.toBeInstanceOf(GroupsUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createGroup', () => {
  it('creates with the first batch and adds the rest paced', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          id: GID,
          name: 'Deal',
          participants: [{ id: '971599999999', rank: 'creator' }].concat(
            phones(5).map((p) => ({ id: p, rank: 'member' }))
          ),
          unprocessed_participants: [phones(5)[4]],
        })
      )
      .mockResolvedValueOnce(
        json({ processed: phones(7).slice(5), failed: [] })
      );
    const res = await createGroup({
      channel: whapiChannel,
      name: '  Deal ',
      participants: phones(7),
      sleep: async () => {},
    });
    expect(bodyOf(0)).toEqual({ subject: 'Deal', participants: phones(5) });
    expect(bodyOf(1)).toEqual({ participants: phones(7).slice(5) });
    expect(res.group.id).toBe(GID);
    expect(res.refused.map((r) => r.waId)).toEqual([phones(5)[4]]);
    expect(res.added.map((r) => r.waId)).toContain(phones(7)[6]);
  });

  it('rejects a name over 100 characters', async () => {
    await expect(
      createGroup({
        channel: whapiChannel,
        name: 'x'.repeat(101),
        participants: phones(1),
      })
    ).rejects.toBeInstanceOf(WhapiError);
  });
});

describe('describeGroupFailure', () => {
  it('words gateway failures as keys', () => {
    expect(describeGroupFailure(new WhapiError('x', 403))).toBe('not_admin');
    expect(describeGroupFailure(new WhapiError('x', 404))).toBe(
      'group_not_found'
    );
    expect(describeGroupFailure(new WhapiError('x', 409))).toBe(
      'already_member'
    );
    expect(describeGroupFailure(new WhapiError('x', 402))).toBe('billing');
    expect(describeGroupFailure(new WhapiError('x', 401))).toBe(
      'channel_disconnected'
    );
    expect(describeGroupFailure(new WhapiError('x', 503))).toBe(
      'gateway_unavailable'
    );
    expect(describeGroupFailure(new GroupsUnsupportedError('meta'))).toBe(
      'not_whapi'
    );
    expect(describeGroupFailure(new Error('x'))).toBe('unknown');
  });
});

describe('ourRoleIn / sendGroupText', () => {
  it('finds our number among the participants', () => {
    const group = {
      participants: [
        { jid: 'a', waId: '971500000001', role: 'admin' as const },
      ],
    };
    expect(ourRoleIn(group, '971500000001')).toBe('admin');
    expect(ourRoleIn(group, '971500000002')).toBeNull();
  });

  it('sends text to the group id untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ sent: true, message: { id: 'm1' } })
    );
    await sendGroupText({ channel: whapiChannel, groupId: GID, text: 'hi' });
    expect(bodyOf(0)).toEqual({ to: GID, body: 'hi' });
  });
});

describe('time budget', () => {
  /** A clock that only moves when the code waits or calls Whapi. */
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      tick: (ms: number) => (t += ms),
    };
  }

  it('starts no batch that would run past the deadline', async () => {
    const c = clock();
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      c.tick(1_000);
      return json({ processed: JSON.parse(init.body as string).participants });
    });
    const res = await addParticipants({
      channel: whapiChannel,
      groupId: GID,
      participants: phones(20),
      sleep: c.sleep,
      now: c.now,
      deadline: 10_000,
    });
    // 0 → 1s, pause → 4s → 5s, pause → 8s → 9s; a 4th pause ends at 12s.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.added).toHaveLength(15);
    expect(res.notAttempted).toEqual(phones(20).slice(15));
    expect(res.error).toBe('time_budget');
  });

  it('bounds each gateway call so it ends before maxDuration', async () => {
    const c = clock();
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      c.tick(1_000);
      timeouts.push(spy.mock.calls.at(-1)![0]);
      return json({ processed: JSON.parse(init.body as string).participants });
    });
    await addParticipants({
      channel: whapiChannel,
      groupId: GID,
      participants: phones(15),
      sleep: c.sleep,
      now: c.now,
      deadline: 45_000,
    });
    // Plenty left: capped at 15 s, never the 30 s default.
    expect(timeouts[0]).toBe(15_000);
    spy.mockRestore();
    expect(callTimeoutMs({ deadline: 45_000, now: () => 40_000 })).toBe(15_000);
    // 2 s left + 10 s slack: the call ends by 52 s.
    expect(callTimeoutMs({ deadline: 45_000, now: () => 43_000 })).toBe(12_000);
    expect(callTimeoutMs({ deadline: 45_000, now: () => 44_900 })).toBe(10_100);
    expect(callTimeoutMs({})).toBeUndefined();
  });

  it('reports a timed-out batch as not attempted', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const res = await addParticipants({
      channel: whapiChannel,
      groupId: GID,
      participants: phones(7),
      deadline: Date.now() + 45_000,
    });
    expect(res.added).toEqual([]);
    expect(res.notAttempted).toEqual(phones(7));
    expect(res.error).not.toBeNull();
  });

  it('carries the deadline through createGroup', async () => {
    const c = clock();
    fetchMock.mockImplementation(async () => {
      c.tick(46_000);
      return json({ id: GID, name: 'Deal', participants: [] });
    });
    const res = await createGroup({
      channel: whapiChannel,
      name: 'Deal',
      participants: phones(7),
      sleep: c.sleep,
      now: c.now,
      deadline: 45_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.notAttempted).toEqual(phones(7).slice(5));
    expect(res.error).toBe('time_budget');
  });
});
