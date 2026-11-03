import { describe, expect, it } from 'vitest';

// The edit-details dialog (Settings → Members) and its API route share
// this rule.

import {
  MAX_MEMBER_EMAIL_LENGTH,
  MAX_MEMBER_NAME_LENGTH,
  memberDetailsProblem,
  normalizeMemberDetails,
} from './member-details';

const ok = { full_name: 'Sara Ali', email: 'sara@example.com' };

describe('normalizeMemberDetails', () => {
  it('trims the name and trims and lower-cases the email', () => {
    expect(
      normalizeMemberDetails({
        full_name: '  Sara Ali ',
        email: ' Sara@Example.COM\n',
      })
    ).toEqual(ok);
  });
});

describe('memberDetailsProblem', () => {
  it('passes good details', () => {
    expect(memberDetailsProblem(ok)).toBeNull();
  });

  it('wants a name, within the profile limit', () => {
    expect(memberDetailsProblem({ ...ok, full_name: '' })).toBe('nameRequired');
    expect(MAX_MEMBER_NAME_LENGTH).toBe(120);
    expect(
      memberDetailsProblem({ ...ok, full_name: 'a'.repeat(120) })
    ).toBeNull();
    expect(memberDetailsProblem({ ...ok, full_name: 'a'.repeat(121) })).toBe(
      'nameTooLong'
    );
    // Characters as a person counts them: an emoji is one.
    expect(
      memberDetailsProblem({ ...ok, full_name: '🙂'.repeat(120) })
    ).toBeNull();
  });

  it('wants an email of a plausible shape', () => {
    expect(memberDetailsProblem({ ...ok, email: '' })).toBe('emailRequired');
    expect(memberDetailsProblem({ ...ok, email: 'sara' })).toBe('emailInvalid');
    expect(memberDetailsProblem({ ...ok, email: 'sara@example' })).toBe(
      'emailInvalid'
    );
    expect(memberDetailsProblem({ ...ok, email: 'sa ra@example.com' })).toBe(
      'emailInvalid'
    );
  });

  it('refuses an email over the address limit', () => {
    const long = `${'a'.repeat(MAX_MEMBER_EMAIL_LENGTH - 12)}@example.com`;
    expect(long.length).toBe(MAX_MEMBER_EMAIL_LENGTH);
    expect(memberDetailsProblem({ ...ok, email: long })).toBeNull();
    expect(memberDetailsProblem({ ...ok, email: `a${long}` })).toBe(
      'emailTooLong'
    );
  });
});
