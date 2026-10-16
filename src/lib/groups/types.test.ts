import { describe, expect, it } from 'vitest';
import { normalizeParticipantRole, parseGroupSettings } from './types';

describe('parseGroupSettings', () => {
  it('keeps known keys with known values', () => {
    expect(
      parseGroupSettings({
        send_messages: 'admins',
        add_participants: 'anyone',
      })
    ).toEqual({ send_messages: 'admins', add_participants: 'anyone' });
  });
  it('drops unknown keys and values', () => {
    expect(
      parseGroupSettings({
        send_messages: 'nobody',
        bogus: 'admins',
        edit_group_info: 3,
      })
    ).toEqual({});
  });
  it('tolerates non-objects', () => {
    for (const v of [null, undefined, 'x', 4, ['admins']]) {
      expect(parseGroupSettings(v)).toEqual({});
    }
  });
});

describe('normalizeParticipantRole', () => {
  it('maps creator to superadmin, admin stays, else member', () => {
    expect(normalizeParticipantRole('creator')).toBe('superadmin');
    expect(normalizeParticipantRole('admin')).toBe('admin');
    expect(normalizeParticipantRole('participant')).toBe('member');
    expect(normalizeParticipantRole(undefined)).toBe('member');
  });
});
