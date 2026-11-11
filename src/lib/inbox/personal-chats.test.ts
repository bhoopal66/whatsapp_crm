import { describe, expect, it } from 'vitest';

import { isOthersPersonalChat, ownPersonalChatsGroup } from './personal-chats';

describe('isOthersPersonalChat (migration 191)', () => {
  it('is false for a company chat', () => {
    expect(isOthersPersonalChat({ personal_owner_id: null }, 'me')).toBe(false);
    expect(isOthersPersonalChat({}, 'me')).toBe(false);
  });

  it('is false for my own personal chat', () => {
    expect(isOthersPersonalChat({ personal_owner_id: 'me' }, 'me')).toBe(false);
  });

  it("is true for someone else's personal chat", () => {
    expect(isOthersPersonalChat({ personal_owner_id: 'hr' }, 'me')).toBe(true);
  });

  it('fails closed while the viewer is unknown', () => {
    expect(isOthersPersonalChat({ personal_owner_id: 'hr' }, null)).toBe(true);
    expect(isOthersPersonalChat({ personal_owner_id: null }, null)).toBe(false);
  });
});

describe('ownPersonalChatsGroup', () => {
  it('asks for company chats and my own personal chats', () => {
    expect(ownPersonalChatsGroup('u1')).toBe(
      'personal_owner_id.is.null,personal_owner_id.eq.u1'
    );
  });
});
