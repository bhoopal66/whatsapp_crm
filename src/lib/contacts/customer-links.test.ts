import { describe, expect, it } from 'vitest';

import { contactsListPath, customerPath, isFromTeam } from './customer-links';

describe('customer-links', () => {
  it('recognises only from=team', () => {
    expect(isFromTeam('team')).toBe(true);
    expect(isFromTeam(undefined)).toBe(false);
    expect(isFromTeam('other')).toBe(false);
    expect(isFromTeam(['team', 'x'])).toBe(false);
  });
  it('returns to the list the customer was opened from', () => {
    expect(contactsListPath(true)).toBe('/team-contacts');
    expect(contactsListPath(false)).toBe('/contacts');
  });
  it('marks a customer link opened from the team list', () => {
    expect(customerPath('abc', true)).toBe('/contacts/abc?from=team');
    expect(customerPath('abc', false)).toBe('/contacts/abc');
  });
});
