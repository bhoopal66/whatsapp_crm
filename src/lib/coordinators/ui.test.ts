import { describe, expect, it } from 'vitest';

import {
  banksByUser,
  banksChanged,
  canHoldCoordinatorBanks,
  canShareWithCoordinator,
  coordinatorChoices,
  isShareOnlyViewer,
  isSharedChatNumberRefusal,
  phoneChanged,
  phoneDraftFrom,
  phoneDraftValid,
  phonesByUser,
  receivesShares,
  sharedBankByConversation,
  toggleBank,
  type CoordinatorRow,
} from './ui';

describe('who is offered what', () => {
  it('offers the share dialog to agent and up, never a viewer or guest', () => {
    expect(canShareWithCoordinator('agent')).toBe(true);
    expect(canShareWithCoordinator('team_leader')).toBe(true);
    expect(canShareWithCoordinator('admin')).toBe(true);
    expect(canShareWithCoordinator('owner')).toBe(true);
    expect(canShareWithCoordinator('viewer')).toBe(false);
    expect(canShareWithCoordinator('bank_guest')).toBe(false);
    expect(canShareWithCoordinator(null)).toBe(false);
  });

  it('lets only agents and team leaders receive shares or hold banks', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      expect(receivesShares(role)).toBe(true);
      expect(canHoldCoordinatorBanks(role)).toBe(true);
    }
    for (const role of ['owner', 'admin', 'viewer', 'bank_guest'] as const) {
      expect(receivesShares(role)).toBe(false);
      expect(canHoldCoordinatorBanks(role)).toBe(false);
    }
    expect(receivesShares(null)).toBe(false);
  });
});

const people: CoordinatorRow[] = [
  { user_id: 'u2', name: 'Zed', banks: ['ADCB'] },
  { user_id: 'u1', name: 'Me', banks: ['ADCB', 'FAB'] },
  { user_id: 'u3', name: 'Amal', banks: ['FAB', 'ADCB'] },
];

describe('coordinatorChoices', () => {
  it("lists the bank's coordinators by name, leaving out the sharer", () => {
    expect(
      coordinatorChoices(people, 'ADCB', 'u1').map((c) => c.user_id)
    ).toEqual(['u3', 'u2']);
    expect(
      coordinatorChoices(people, 'FAB', 'u1').map((c) => c.user_id)
    ).toEqual(['u3']);
  });

  it('lists nobody before a bank is picked', () => {
    expect(coordinatorChoices(people, null, 'u1')).toEqual([]);
  });
});

describe('sharedBankByConversation', () => {
  it('names each chat by its first open share', () => {
    const map = sharedBankByConversation([
      { conversation_id: 'k1', bank_code: 'ADCB' },
      { conversation_id: 'k2', bank_code: 'FAB' },
      { conversation_id: 'k1', bank_code: 'FAB' },
    ]);
    expect([...map]).toEqual([
      ['k1', 'ADCB'],
      ['k2', 'FAB'],
    ]);
  });
});

describe('isShareOnlyViewer', () => {
  const conv = { user_id: 'owner', assigned_agent_id: 'agent' };

  it('is a coordinator who neither owns nor holds the chat', () => {
    expect(isShareOnlyViewer('agent', 'coord', conv, true)).toBe(true);
  });

  it('never calls a team leader share-only (the client cannot see who they lead)', () => {
    expect(isShareOnlyViewer('team_leader', 'coord', conv, true)).toBe(false);
  });

  it('is not the owner, the assignee, an admin, or someone without a share', () => {
    expect(isShareOnlyViewer('agent', 'owner', conv, true)).toBe(false);
    expect(isShareOnlyViewer('agent', 'agent', conv, true)).toBe(false);
    expect(isShareOnlyViewer('admin', 'coord', conv, true)).toBe(false);
    expect(isShareOnlyViewer('agent', 'coord', conv, false)).toBe(false);
    expect(isShareOnlyViewer(null, 'coord', conv, true)).toBe(false);
  });
});

describe('isSharedChatNumberRefusal', () => {
  it("recognises the send route's 409 shared_chat_number", () => {
    expect(
      isSharedChatNumberRefusal(409, { error: 'x', code: 'shared_chat_number' })
    ).toBe(true);
    expect(isSharedChatNumberRefusal(400, { code: 'shared_chat_number' })).toBe(
      false
    );
    expect(isSharedChatNumberRefusal(409, { code: 'other' })).toBe(false);
    expect(isSharedChatNumberRefusal(409, null)).toBe(false);
  });
});

describe('bank selection helpers', () => {
  it('maps people to their sorted banks', () => {
    expect(banksByUser(people).get('u3')).toEqual(['ADCB', 'FAB']);
  });

  it('toggles a code, sorted and distinct', () => {
    expect(toggleBank(['FAB'], 'ADCB')).toEqual(['ADCB', 'FAB']);
    expect(toggleBank(['ADCB', 'FAB'], 'ADCB')).toEqual(['FAB']);
  });
});

describe('banksChanged', () => {
  it('ignores order, sees additions and removals', () => {
    expect(banksChanged(['ADCB', 'FAB'], ['FAB', 'ADCB'])).toBe(false);
    expect(banksChanged([], [])).toBe(false);
    expect(banksChanged(['ADCB'], [])).toBe(true);
    expect(banksChanged(['ADCB'], ['ADCB', 'FAB'])).toBe(true);
    expect(banksChanged(['ADCB'], ['FAB'])).toBe(true);
  });
});

describe('coordinator WhatsApp number (142)', () => {
  it('maps saved numbers by person, leaving out people without one', () => {
    const map = phonesByUser([
      { user_id: 'u1', name: 'A', banks: ['ADCB'], whatsapp_phone: '97150' },
      { user_id: 'u2', name: 'B', banks: ['FAB'], whatsapp_phone: null },
      { user_id: 'u3', name: 'C', banks: ['FAB'] },
    ]);
    expect([...map]).toEqual([['u1', '97150']]);
  });

  it('shows a saved number with a plus, and nothing when unset', () => {
    expect(phoneDraftFrom('971501234567')).toBe('+971501234567');
    expect(phoneDraftFrom(null)).toBe('');
    expect(phoneDraftFrom(undefined)).toBe('');
  });

  it('accepts blank or 5-25 digits in phone characters only', () => {
    expect(phoneDraftValid('')).toBe(true);
    expect(phoneDraftValid('   ')).toBe(true);
    expect(phoneDraftValid('+971 (50) 123-4567')).toBe(true);
    expect(phoneDraftValid('12345')).toBe(true);
    expect(phoneDraftValid('1234')).toBe(false);
    expect(phoneDraftValid('1'.repeat(26))).toBe(false);
    expect(phoneDraftValid('971x501234567')).toBe(false);
  });

  it('compares digits only against the saved number', () => {
    expect(phoneChanged('971501234567', '+971 50 123 4567')).toBe(false);
    expect(phoneChanged('971501234567', '+971 50 123 4568')).toBe(true);
    expect(phoneChanged(null, '')).toBe(false);
    expect(phoneChanged(null, ' ')).toBe(false);
    expect(phoneChanged('971501234567', '')).toBe(true);
    expect(phoneChanged(undefined, '+97150')).toBe(true);
  });
});
