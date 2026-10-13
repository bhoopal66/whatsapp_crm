import { describe, expect, it } from 'vitest';

import { ChatError } from '../errors';
import {
  createChannelInput,
  dealRoomOption,
  nameTakenError,
  privateMemberCandidates,
  type NewChannelForm,
} from '../new-channel';
import type { ChatPerson } from '../types';

const person = (userId: string, role: string): ChatPerson => ({
  userId,
  fullName: userId,
  avatarUrl: null,
  role,
  bankCode: null,
  presenceStatus: null,
  lastSeenAt: null,
});

const PEOPLE = [
  person('me', 'agent'),
  person('ann', 'agent'),
  person('bob', 'viewer'),
  person('gus', 'bank_guest'),
];

const form = (over: Partial<NewChannelForm> = {}): NewChannelForm => ({
  type: 'team',
  name: 'Credit Review',
  topic: '',
  memberIds: [],
  ...over,
});

describe('privateMemberCandidates', () => {
  it('leaves the creator out and offers guests only to owner/admin/team leader', () => {
    const ids = (role: string) =>
      privateMemberCandidates(PEOPLE, 'me', role).map((p) => p.userId);
    expect(ids('agent')).toEqual(['ann', 'bob']);
    expect(ids('team_leader')).toEqual(['ann', 'bob', 'gus']);
    expect(ids('admin')).toEqual(['ann', 'bob', 'gus']);
    expect(ids('bank_guest')).toEqual([]);
    expect(privateMemberCandidates(PEOPLE, null, 'owner')).toEqual([]);
  });
});

describe('createChannelInput', () => {
  it('builds the call: final name, trimmed topic, members for private only', () => {
    expect(
      createChannelInput(
        form({ topic: '  Weekly  ', memberIds: ['ann'] }),
        'ws',
        []
      )
    ).toEqual({
      accountId: 'ws',
      kind: 'team',
      name: 'credit-review',
      topic: 'Weekly',
      memberIds: [],
    });
    expect(
      createChannelInput(
        form({ type: 'private', memberIds: ['ann', 'bob', 'ann'] }),
        'ws',
        []
      )
    ).toMatchObject({
      kind: 'private',
      topic: null,
      memberIds: ['ann', 'bob'],
    });
    const long = createChannelInput(form({ topic: 'x'.repeat(300) }), 'ws', []);
    expect(typeof long === 'object' && long.topic).toHaveLength(250);
  });

  it('says why it cannot be made yet', () => {
    const taken = [
      { kind: 'team' as const, name: 'credit-review', archivedAt: null },
    ];
    expect(createChannelInput(form({ type: 'deal_room' }), 'ws', [])).toBe(
      'dealRoom'
    );
    expect(createChannelInput(form(), null, [])).toBe('noWorkspace');
    expect(createChannelInput(form({ name: ' -- ' }), 'ws', [])).toBe('empty');
    expect(createChannelInput(form(), 'ws', taken)).toBe('taken');
  });
});

describe('nameTakenError', () => {
  it('is the unique-name refusal only', () => {
    const dup = new ChatError(
      'CONFLICT',
      'duplicateName',
      'duplicate key value violates unique constraint "chat_channels_name_uq"',
      '23505'
    );
    expect(nameTakenError(dup)).toBe(true);
    expect(nameTakenError(new ChatError('CONFLICT', 'conflict', 'x'))).toBe(
      false
    );
    expect(nameTakenError(new Error('x'))).toBe(false);
  });
});

describe('dealRoomOption', () => {
  it('agents and up open a deal room, a viewer is told why not, a guest never sees it', () => {
    for (const role of ['owner', 'admin', 'team_leader', 'agent'])
      expect(dealRoomOption(role)).toBe('open');
    expect(dealRoomOption('viewer')).toBe('agentsOnly');
    expect(dealRoomOption('bank_guest')).toBe('hidden');
    expect(dealRoomOption(null)).toBe('hidden');
    expect(dealRoomOption('nonsense')).toBe('hidden');
  });
});
