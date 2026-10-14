import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '../../../../messages/en.json';
import ko from '../../../../messages/ko.json';
import {
  EMPTY_GROUPS,
  GROUPS_MESSAGE_KEYS,
  actionErrorKey,
  agentActions,
  agentChip,
  agentState,
  callStatusChip,
  displayName,
  errorCode,
  isEmptyGroups,
  loadErrorKey,
  myQueueState,
  parseGroupsPayload,
  sortAgents,
  strategyKey,
  type QueueAgent,
  type QueueView,
} from '../groups';

const agent = (over: Partial<QueueAgent> = {}): QueueAgent => ({
  extension: '101',
  userId: null,
  name: null,
  static: false,
  loggedIn: true,
  paused: false,
  callStatus: 'idle',
  ...over,
});

const queue = (agents: QueueAgent[]): QueueView => ({
  id: 7,
  number: '6400',
  name: 'Sales',
  agents,
});

describe('parseGroupsPayload', () => {
  it('reads the contract shape', () => {
    const p = parseGroupsPayload({
      myExtension: '101',
      canManage: true,
      ringGroups: [
        {
          id: 1,
          number: '6300',
          name: 'Front desk',
          strategy: 'ring_all',
          members: [{ extension: '101', userId: 'u1', name: 'Amal' }],
        },
      ],
      queues: [
        {
          id: 7,
          number: '6400',
          name: 'Sales',
          agents: [
            {
              extension: '102',
              userId: null,
              name: null,
              static: true,
              loggedIn: true,
              paused: true,
              callStatus: 'on_hold',
            },
          ],
        },
      ],
      queuesTruncated: true,
    });
    expect(p).toEqual({
      myExtension: '101',
      canManage: true,
      ringGroups: [
        {
          id: 1,
          number: '6300',
          name: 'Front desk',
          strategy: 'ring_all',
          members: [{ extension: '101', userId: 'u1', name: 'Amal' }],
        },
      ],
      queues: [
        {
          id: 7,
          number: '6400',
          name: 'Sales',
          agents: [
            {
              extension: '102',
              userId: null,
              name: null,
              static: true,
              loggedIn: true,
              paused: true,
              callStatus: 'on_hold',
            },
          ],
        },
      ],
      queuesTruncated: true,
    });
  });

  it('turns an unknown shape into empty lists', () => {
    for (const raw of [null, undefined, 'x', 3, [], { error: 'boom' }])
      expect(parseGroupsPayload(raw)).toEqual(EMPTY_GROUPS);
    expect(parseGroupsPayload({ ringGroups: 'no', queues: { id: 1 } })).toEqual(
      EMPTY_GROUPS
    );
  });

  it('drops entries without an id or number and defaults the rest', () => {
    const p = parseGroupsPayload({
      canManage: 'yes',
      queuesTruncated: 1,
      ringGroups: [
        { id: '1', number: '6300' },
        { id: 2, number: '' },
        {
          id: 3,
          number: '6303',
          members: [{ name: 'x' }, 5, { extension: '9' }],
        },
      ],
      queues: [
        null,
        {
          id: 4,
          number: '6404',
          agents: [
            { extension: '1', callStatus: 'dancing', loggedIn: 'true' },
            { extension: '' },
          ],
        },
      ],
    });
    expect(p.canManage).toBe(false);
    expect(p.queuesTruncated).toBe(false);
    expect(p.myExtension).toBeNull();
    expect(p.ringGroups).toEqual([
      {
        id: 3,
        number: '6303',
        name: '6303',
        strategy: '',
        members: [{ extension: '9', userId: null, name: null }],
      },
    ]);
    expect(p.queues).toEqual([
      {
        id: 4,
        number: '6404',
        name: '6404',
        agents: [
          {
            extension: '1',
            userId: null,
            name: null,
            static: false,
            loggedIn: false,
            paused: false,
            callStatus: 'unknown',
          },
        ],
      },
    ]);
  });

  it('knows an empty payload', () => {
    expect(isEmptyGroups(EMPTY_GROUPS)).toBe(true);
    expect(isEmptyGroups({ ...EMPTY_GROUPS, queues: [queue([])] })).toBe(false);
  });
});

describe('agent state and chips', () => {
  it('is offline when logged out, whatever else it says', () => {
    expect(
      agentState(
        agent({ loggedIn: false, paused: true, callStatus: 'in_call' })
      )
    ).toBe('offline');
  });

  it('puts a live call ahead of a pause', () => {
    expect(agentState(agent({ paused: true, callStatus: 'in_call' }))).toBe(
      'on_call'
    );
    expect(agentState(agent({ callStatus: 'on_hold' }))).toBe('on_call');
    expect(agentState(agent({ callStatus: 'waiting' }))).toBe('on_call');
    expect(agentState(agent({ paused: true, callStatus: 'ringing' }))).toBe(
      'ringing'
    );
    expect(agentState(agent({ paused: true }))).toBe('paused');
    expect(agentState(agent())).toBe('available');
    expect(agentState(agent({ callStatus: 'unknown' }))).toBe('available');
  });

  it('names the call status on a call and the state otherwise', () => {
    expect(agentChip(agent({ callStatus: 'on_hold' }))).toEqual({
      key: 'statusOnHold',
      tone: 'amber',
    });
    expect(agentChip(agent({ callStatus: 'ringing' }))).toEqual({
      key: 'statusRinging',
      tone: 'blue',
    });
    expect(agentChip(agent({ loggedIn: false }))).toEqual({
      key: 'stateOffline',
      tone: 'muted',
    });
    expect(agentChip(agent({ paused: true }))).toEqual({
      key: 'statePaused',
      tone: 'amber',
    });
    expect(agentChip(agent())).toEqual({
      key: 'stateAvailable',
      tone: 'green',
    });
    expect(callStatusChip('in_call')).toEqual({
      key: 'statusInCall',
      tone: 'red',
    });
  });
});

describe('myQueueState', () => {
  it('offers nothing to someone outside the queue or with no phone', () => {
    const q = queue([agent({ extension: '102' })]);
    for (const ext of ['101', null])
      expect(myQueueState(q, ext)).toEqual({
        member: false,
        static: false,
        loggedIn: false,
        paused: false,
        actions: [],
      });
  });

  it('offers a logged-out dynamic agent Log in only', () => {
    expect(
      myQueueState(queue([agent({ loggedIn: false })]), '101').actions
    ).toEqual(['login']);
  });

  it('offers a logged-in agent Log out and Pause or Resume', () => {
    expect(myQueueState(queue([agent()]), '101')).toEqual({
      member: true,
      static: false,
      loggedIn: true,
      paused: false,
      actions: ['logout', 'pause'],
    });
    expect(
      myQueueState(queue([agent({ paused: true })]), '101').actions
    ).toEqual(['logout', 'unpause']);
  });

  it('never offers a static agent Log in or Log out', () => {
    expect(
      myQueueState(queue([agent({ static: true })]), '101').actions
    ).toEqual(['pause']);
    expect(
      myQueueState(queue([agent({ static: true, paused: true })]), '101')
        .actions
    ).toEqual(['unpause']);
    expect(
      myQueueState(queue([agent({ static: true, loggedIn: false })]), '101')
        .actions
    ).toEqual([]);
  });
});

describe('agentActions', () => {
  it('gives a manager the same rules on someone else', () => {
    const m = { canManage: true, isMe: false };
    expect(agentActions(agent({ loggedIn: false }), m)).toEqual(['login']);
    expect(agentActions(agent({ paused: true }), m)).toEqual([
      'logout',
      'unpause',
    ]);
    expect(agentActions(agent({ static: true }), m)).toEqual(['pause']);
  });

  it('gives a non-manager nothing, and nobody buttons on their own row', () => {
    expect(agentActions(agent(), { canManage: false, isMe: false })).toEqual(
      []
    );
    expect(agentActions(agent(), { canManage: true, isMe: true })).toEqual([]);
  });
});

describe('names and order', () => {
  it('falls back to the extension', () => {
    expect(displayName({ name: 'Amal', extension: '101' })).toBe('Amal');
    expect(displayName({ name: null, extension: '101' })).toBe('Ext 101');
    expect(displayName({ name: '  ', extension: '101' })).toBe('Ext 101');
    expect(
      displayName({ name: null, extension: '101' }, (e) => `내선 ${e}`)
    ).toBe('내선 101');
  });

  it('puts me first, then names, then extensions in number order', () => {
    const list = [
      agent({ extension: '110', name: null }),
      agent({ extension: '102', name: 'zaid' }),
      agent({ extension: '120', name: 'Amal' }),
      agent({ extension: '99', name: null }),
      agent({ extension: '130', name: 'Me' }),
    ];
    expect(sortAgents(list, '130').map((a) => a.extension)).toEqual([
      '130',
      '99',
      '110',
      '120',
      '102',
    ]);
    expect(sortAgents(list, null)[0].extension).toBe('99');
    expect(list[0].extension).toBe('110');
  });
});

describe('codes and strategies', () => {
  it('maps known action errors and falls back to a generic one', () => {
    expect(actionErrorKey('static_agent')).toBe('errStaticAgent');
    expect(actionErrorKey('not_in_queue')).toBe('errNotInQueue');
    expect(actionErrorKey('queue_not_found')).toBe('errQueueNotFound');
    expect(actionErrorKey('no_extension')).toBe('errNoExtension');
    expect(actionErrorKey('Internal wording from the PBX')).toBe('errAction');
    expect(actionErrorKey(null)).toBe('errAction');
    expect(actionErrorKey('constructor')).toBe('errAction');
  });

  it('maps a load failure', () => {
    expect(loadErrorKey('no_extension')).toBe('loadNoExtension');
    expect(loadErrorKey('forbidden')).toBe('loadFailed');
    expect(loadErrorKey(null)).toBe('loadFailed');
  });

  it('reads the error code of a body', () => {
    expect(errorCode({ error: 'static_agent' })).toBe('static_agent');
    expect(errorCode({ error: { code: 'x' } })).toBeNull();
    expect(errorCode(null)).toBeNull();
  });

  it('names the known strategies only', () => {
    expect(strategyKey('ring_all')).toBe('strategyRingAll');
    expect(strategyKey('memory_hunt')).toBe('strategyMemoryHunt');
    expect(strategyKey('weird')).toBeNull();
    expect(strategyKey('toString')).toBeNull();
  });

  it('has every key it returns in both catalogues', () => {
    for (const messages of [en, ko]) {
      const t = createTranslator({
        locale: 'en',
        messages,
        namespace: 'PbxGroups',
      });
      const block: Record<string, string> = messages.PbxGroups;
      for (const key of GROUPS_MESSAGE_KEYS) {
        expect(block[key], key).toBeTypeOf('string');
        expect(t(key as never)).not.toBe(`PbxGroups.${key}`);
      }
    }
  });
});
