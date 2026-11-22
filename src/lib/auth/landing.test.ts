import { describe, expect, it } from 'vitest';

import { landingPathForRole } from './landing';

describe('landingPathForRole', () => {
  it('sends agents and team leaders to My worklist', () => {
    expect(landingPathForRole('agent')).toBe('/worklist');
    expect(landingPathForRole('team_leader')).toBe('/worklist');
  });

  it('keeps owners, admins and viewers on the dashboard', () => {
    expect(landingPathForRole('owner')).toBe('/dashboard');
    expect(landingPathForRole('admin')).toBe('/dashboard');
    expect(landingPathForRole('viewer')).toBe('/dashboard');
  });

  it('keeps a bank guest on team chat', () => {
    expect(landingPathForRole('bank_guest')).toBe('/chat');
  });

  it('falls back to the dashboard while the role is unknown', () => {
    expect(landingPathForRole(null)).toBe('/dashboard');
    expect(landingPathForRole(undefined)).toBe('/dashboard');
  });
});
