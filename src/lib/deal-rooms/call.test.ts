import { describe, expect, it } from 'vitest';

import { offersParticipantCall, participantCallBlock } from './call';

const base = {
  role: 'customer',
  status: 'joined',
  roomStatus: 'open',
  bankGuestsAllowed: false,
};

describe('participantCallBlock', () => {
  it('calls a listed customer or partner who was let in', () => {
    for (const status of ['invited', 'joined', 'left'])
      expect(participantCallBlock({ ...base, status })).toBeNull();
    expect(participantCallBlock({ ...base, role: 'partner' })).toBeNull();
  });

  it('never calls our own number, an unlisted person, or someone removed, rejected or pending', () => {
    expect(participantCallBlock({ ...base, role: 'business' })).toBe(
      'not_callable'
    );
    expect(participantCallBlock({ ...base, role: null })).toBe('not_callable');
    for (const status of ['removed', 'rejected', 'pending_approval'])
      expect(participantCallBlock({ ...base, status })).toBe('not_callable');
  });

  it('calls a bank officer only while the bank’s guests are on (D-Y7)', () => {
    const bank = { ...base, role: 'bank_guest' };
    expect(participantCallBlock(bank)).toBe('bank_guests_off');
    expect(
      participantCallBlock({ ...bank, bankGuestsAllowed: true })
    ).toBeNull();
  });

  it('calls nobody from a closed or failed room', () => {
    for (const roomStatus of ['closed', 'failed'])
      expect(participantCallBlock({ ...base, roomStatus })).toBe('room_closed');
  });
});

describe('offersParticipantCall', () => {
  const p = { role: 'bank_guest', status: 'joined' };
  it('offers business-side staff from agent up, never a bank guest or a viewer', () => {
    expect(offersParticipantCall('agent', p, 'open')).toBe(true);
    expect(offersParticipantCall('owner', p, 'open')).toBe(true);
    expect(offersParticipantCall('viewer', p, 'open')).toBe(false);
    expect(offersParticipantCall('bank_guest', p, 'open')).toBe(false);
    expect(offersParticipantCall(null, p, 'open')).toBe(false);
    expect(
      offersParticipantCall('admin', { ...p, role: 'business' }, 'open')
    ).toBe(false);
  });
});
