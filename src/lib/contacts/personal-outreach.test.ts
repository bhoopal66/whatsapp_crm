import { describe, expect, it } from 'vitest';

import {
  personalSendFailureKey,
  showPersonalOption,
} from './personal-outreach';

describe('showPersonalOption', () => {
  it('needs permission and a connected number', () => {
    expect(
      showPersonalOption({ allowed: true, number: { status: 'connected' } })
    ).toBe(true);
  });
  it.each([
    [null],
    [undefined],
    [{ allowed: false, number: { status: 'connected' } }],
    [{ allowed: true, number: null }],
    [{ allowed: true, number: { status: 'disconnected' } }],
    [{ allowed: true, number: { status: null } }],
  ])('hides it for %j', (info) => {
    expect(showPersonalOption(info)).toBe(false);
  });
});

describe('personalSendFailureKey', () => {
  it('names the no-number refusal', () => {
    expect(personalSendFailureKey(409, { code: 'no_personal_number' })).toBe(
      'noPersonalNumber'
    );
  });
  it('leaves every other failure to the route text', () => {
    expect(personalSendFailureKey(409, { code: 'other' })).toBeNull();
    expect(
      personalSendFailureKey(500, { code: 'no_personal_number' })
    ).toBeNull();
    expect(personalSendFailureKey(409, null)).toBeNull();
  });
});
