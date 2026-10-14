import { describe, it, expect } from 'vitest';
import { YeastarError } from '../errors';
import { endpointOf, setup, type Call } from './fixtures';

// Shapes from the P-Series developer guide: ringgroup/list,
// ringgroup/query (query-information-of-multiple-ring-groups),
// queue/list, queue/agent_status, agent/login, agent/pause,
// queue/agent_login and queue/agent_pause.

const OK = { errcode: 0, errmsg: 'SUCCESS' };
/** The query without the token every call carries. */
const params = (c: Call): Record<string, string> => {
  const q = Object.fromEntries(c.url.searchParams);
  delete q.access_token;
  return q;
};

describe('listRingGroups', () => {
  it('lists ids, then queries them for extension members only', async () => {
    const { api, calls } = setup((c) =>
      endpointOf(c) === 'ringgroup/list'
        ? {
            ...OK,
            total_number: 2,
            data: [
              { id: 1, number: '6300', name: 'Sales', member_count: 3 },
              { id: 4, number: '6301', name: 'VIP', member_count: 2 },
            ],
          }
        : {
            ...OK,
            data: [
              {
                id: 1,
                number: '6300',
                name: 'Sales',
                ring_strategy: 'ring_all',
                member_list: [
                  {
                    value: '12',
                    type: 'extension',
                    text: 'Leo',
                    text2: '2000',
                  },
                  { value: '3', type: 'ext_group', text: 'G', text2: 'G' },
                  { value: '', type: 'external', text: 'X', text2: '0501' },
                ],
              },
              {
                id: 4,
                number: '6301',
                name: 'VIP',
                ring_strategy: 'custom',
                member_list: [
                  {
                    delay_time: 0,
                    sub_option: [
                      {
                        value: '12',
                        type: 'extension',
                        text: 'Leo',
                        text2: '2000',
                      },
                      {
                        value: '13',
                        type: 'extension',
                        text: 'Kim',
                        text2: '2001',
                      },
                    ],
                  },
                  {
                    sub_option: [
                      {
                        value: '12',
                        type: 'extension',
                        text: 'Leo',
                        text2: '2000',
                      },
                    ],
                  },
                ],
              },
            ],
          }
    );
    const out = await api.listRingGroups();
    expect(calls.map(endpointOf)).toEqual([
      'ringgroup/list',
      'ringgroup/query',
    ]);
    expect(params(calls[0])).toMatchObject({ page: '1', page_size: '100' });
    expect(params(calls[1]).ids).toBe('1,4');
    expect(out).toEqual([
      {
        id: 1,
        number: '6300',
        name: 'Sales',
        strategy: 'ring_all',
        members: [{ number: '2000', name: 'Leo' }],
      },
      {
        id: 4,
        number: '6301',
        name: 'VIP',
        strategy: 'custom',
        // A custom strategy's members, each once.
        members: [
          { number: '2000', name: 'Leo' },
          { number: '2001', name: 'Kim' },
        ],
      },
    ]);
  });

  it('makes no query call when there are no ring groups', async () => {
    const { api, calls } = setup(() => ({ ...OK, total_number: 0, data: [] }));
    expect(await api.listRingGroups()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('listQueues', () => {
  it('reads queue_list, pages by total_number, keeps agents with ext ids', async () => {
    const row = (id: number) => ({
      id,
      number: `64${id}`,
      name: `Q${id}`,
      ring_strategy: 'ring_all',
      dynamic_agent_list:
        id === 1
          ? null
          : [{ text: 'Leo', text2: '2000', value: '12', type: 'extension' }],
      static_agent_list: [
        { text: 'Kim', text2: '2001', value: '13', type: 'extension' },
      ],
      manager_list: [],
    });
    const { api, calls } = setup((c) =>
      c.url.searchParams.get('page') === '1'
        ? {
            ...OK,
            total_number: 101,
            queue_list: Array.from({ length: 100 }, (_, i) => row(i + 1)),
          }
        : { ...OK, total_number: 101, queue_list: [row(101)] }
    );
    const out = await api.listQueues();
    expect(calls.map((c) => [endpointOf(c), params(c).page])).toEqual([
      ['queue/list', '1'],
      ['queue/list', '2'],
    ]);
    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({
      id: 1,
      number: '641',
      name: 'Q1',
      strategy: 'ring_all',
      dynamicAgents: [],
      staticAgents: [{ extId: 13, number: '2001', name: 'Kim' }],
    });
    expect(out[1].dynamicAgents).toEqual([
      { extId: 12, number: '2000', name: 'Leo' },
    ]);
  });

  it('fails on a queue_list that is not a list', async () => {
    const { api } = setup(() => ({ ...OK, queue_list: {} }));
    await expect(api.listQueues()).rejects.toBeInstanceOf(YeastarError);
  });
});

describe('queueAgentStatus', () => {
  it('GETs queue/agent_status?id= and maps each agent', async () => {
    const { api, calls } = setup(() => ({
      ...OK,
      total_number: 2,
      data: [
        {
          name: 'Leo',
          number: '2000',
          is_login: 1,
          is_pause: 1,
          call_status: 2,
          pause_reason: 'Lunch',
          agent_type: 'dynamic',
          max_threshold_for_pause_time: 0,
        },
        {
          name: 'Kim',
          number: '2001',
          is_login: 0,
          is_pause: 0,
          agent_type: 'static',
        },
      ],
    }));
    const out = await api.queueAgentStatus(3);
    expect(endpointOf(calls[0])).toBe('queue/agent_status');
    expect(params(calls[0]).id).toBe('3');
    expect(out).toEqual([
      {
        number: '2000',
        name: 'Leo',
        loggedIn: true,
        paused: true,
        callStatus: 2,
        pauseReason: 'Lunch',
        agentType: 'dynamic',
      },
      {
        number: '2001',
        name: 'Kim',
        loggedIn: false,
        paused: false,
        callStatus: 0,
        pauseReason: '',
        agentType: 'static',
      },
    ]);
  });

  it('refuses a queue id that is not a positive integer, without a call', async () => {
    const { api, calls } = setup(() => OK);
    await expect(api.queueAgentStatus(0)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('agent and manager actions', () => {
  it('agentLogin sends ext_id, operation and queue_ids, never reason', async () => {
    const { api, calls } = setup(() => OK);
    await api.agentLogin({ extId: 85, operation: 'logout', queueIds: [3, 4] });
    await api.agentLogin({ extId: 85, operation: 'login' });
    expect(calls.map(endpointOf)).toEqual(['agent/login', 'agent/login']);
    expect(calls[0].method).toBe('GET');
    const first = params(calls[0]);
    expect(first).toEqual({
      ext_id: '85',
      operation: 'logout',
      queue_ids: '3,4',
    });
    // No queue ids: every queue of the agent's.
    expect(params(calls[1]).queue_ids).toBeUndefined();
  });

  it('agentPause GETs agent/pause without a reason', async () => {
    const { api, calls } = setup(() => OK);
    await api.agentPause({ extId: 85, operation: 'unpause', queueIds: [3] });
    expect(endpointOf(calls[0])).toBe('agent/pause');
    const q = params(calls[0]);
    expect(q).toEqual({ ext_id: '85', operation: 'unpause', queue_ids: '3' });
  });

  it('manager calls send ext_ids and queue_id', async () => {
    const { api, calls } = setup(() => OK);
    await api.managerAgentLogin({
      extIds: [21, 24],
      queueId: 1,
      operation: 'login',
    });
    await api.managerAgentPause({
      extIds: [73],
      queueId: 2,
      operation: 'pause',
    });
    expect(calls.map(endpointOf)).toEqual([
      'queue/agent_login',
      'queue/agent_pause',
    ]);
    const strip = params;
    expect(strip(calls[0])).toEqual({
      ext_ids: '21,24',
      queue_id: '1',
      operation: 'login',
    });
    expect(strip(calls[1])).toEqual({
      ext_ids: '73',
      queue_id: '2',
      operation: 'pause',
    });
  });

  it('refuses bad ids without a call, and passes a PBX refusal through', async () => {
    const { api, calls } = setup(() => ({ errcode: 10002, errmsg: 'FAILURE' }));
    await expect(
      api.managerAgentPause({ extIds: [], queueId: 2, operation: 'pause' })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      api.agentLogin({ extId: 1.5, operation: 'login' })
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
    await expect(
      api.agentPause({ extId: 85, operation: 'pause' })
    ).rejects.toBeInstanceOf(YeastarError);
  });
});
