import { describe, expect, it } from 'vitest';

import { validatePhoneToSave } from '@/lib/contacts/phone-validation';

import {
  decideNewChat,
  pickConversationToOpen,
  type NewChatFacts,
} from './new-chat';

const ME = 'user-me';
const PHONE = validatePhoneToSave(null, '+971 50 123 4567');

function facts(over: Partial<NewChatFacts> = {}): NewChatFacts {
  return { phone: PHONE, userId: ME, hasPersonalNumber: false, ...over };
}

describe('decideNewChat', () => {
  it('refuses a number without a country code before any lookup', () => {
    const step = decideNewChat(
      facts({ phone: validatePhoneToSave(null, '050 123 4567') })
    );
    expect(step.kind).toBe('invalid-phone');
  });

  it('refuses an empty number', () => {
    expect(
      decideNewChat(facts({ phone: validatePhoneToSave(null, ' ') }))
    ).toMatchObject({ kind: 'invalid-phone' });
  });

  it('looks the contact up first, with the normalized number', () => {
    expect(decideNewChat(facts())).toEqual({
      kind: 'find-contact',
      phone: '971501234567',
    });
  });

  it('inserts when no visible contact has the number', () => {
    expect(decideNewChat(facts({ visibleContact: null }))).toEqual({
      kind: 'insert-contact',
      phone: '971501234567',
    });
  });

  it('uses a visible contact without inserting', () => {
    const contact = { id: 'c1', phone: '971501234567' };
    expect(decideNewChat(facts({ visibleContact: contact }))).toEqual({
      kind: 'find-conversations',
      contact,
    });
  });

  it('refuses a number held by a contact the caller cannot see', () => {
    expect(
      decideNewChat(
        facts({
          visibleContact: null,
          insert: { kind: 'unique-violation', visible: null },
        })
      )
    ).toEqual({ kind: 'hidden-conflict' });
  });

  it('inserts the typed number when the visible contact only shares its last 8 digits', () => {
    // +91 98 0123 4567: a different person, same last 8 digits.
    const nearMatch = { id: 'c9', phone: '+91 98 0123 4567' };
    expect(decideNewChat(facts({ visibleContact: nearMatch }))).toEqual({
      kind: 'insert-contact',
      phone: '971501234567',
    });
  });

  it('refuses rather than move to a near match when the exact number is hidden', () => {
    const nearMatch = { id: 'c9', phone: '919801234567' };
    expect(
      decideNewChat(
        facts({
          visibleContact: null,
          insert: { kind: 'unique-violation', visible: nearMatch },
        })
      )
    ).toEqual({ kind: 'hidden-conflict' });
  });

  it('uses a visible contact stored with spaces and a plus', () => {
    const contact = { id: 'c1', phone: '+971 50 123 4567' };
    expect(decideNewChat(facts({ visibleContact: contact }))).toEqual({
      kind: 'find-conversations',
      contact,
    });
  });

  it('takes the contact a lost insert race turned up', () => {
    const contact = { id: 'c2', phone: '971501234567' };
    expect(
      decideNewChat(
        facts({
          visibleContact: null,
          insert: { kind: 'unique-violation', visible: contact },
        })
      )
    ).toEqual({ kind: 'find-conversations', contact });
  });

  it('reports any other insert failure', () => {
    expect(
      decideNewChat(
        facts({
          visibleContact: null,
          insert: { kind: 'error', message: 'boom' },
        })
      )
    ).toEqual({ kind: 'failed', message: 'boom' });
  });

  it('composes the first message for a new contact with no chat', () => {
    expect(
      decideNewChat(
        facts({
          visibleContact: null,
          insert: { kind: 'created', id: 'new' },
          conversations: [],
        })
      )
    ).toEqual({
      kind: 'compose',
      contact: { id: 'new', phone: '971501234567' },
    });
  });

  it('opens a chat the caller can already see', () => {
    expect(
      decideNewChat(
        facts({
          visibleContact: { id: 'c1', phone: '971501234567' },
          conversations: [{ id: 'conv-1', personal_owner_id: null }],
        })
      )
    ).toEqual({ kind: 'open-conversation', conversationId: 'conv-1' });
  });
});

describe('pickConversationToOpen', () => {
  const company = { id: 'company', personal_owner_id: null };
  const mine = { id: 'mine', personal_owner_id: ME };
  const theirs = { id: 'theirs', personal_owner_id: 'someone-else' };

  it('prefers my personal chat when I have a personal number', () => {
    expect(pickConversationToOpen([company, mine], ME, true)).toBe('mine');
  });

  it('prefers the company chat otherwise', () => {
    expect(pickConversationToOpen([mine, company], ME, false)).toBe('company');
  });

  it('falls back to whichever of the two exists', () => {
    expect(pickConversationToOpen([company], ME, true)).toBe('company');
    expect(pickConversationToOpen([mine], ME, false)).toBe('mine');
  });

  it("never opens a colleague's personal chat", () => {
    expect(pickConversationToOpen([theirs], ME, true)).toBeNull();
    expect(pickConversationToOpen([theirs], ME, false)).toBeNull();
  });

  it('opens nothing when there is no chat', () => {
    expect(pickConversationToOpen([], ME, false)).toBeNull();
  });
});
