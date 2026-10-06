import { describe, it, expect } from 'vitest';
import {
  parseVcard,
  metaContactToShared,
  contactCardsText,
} from './contact-card';

describe('parseVcard', () => {
  it('reads the fields WhatsApp puts on a shared card', () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Al Mansoori;Ahmed;;;',
      'FN:Ahmed Al Mansoori',
      'ORG:Dargol Logistics FZE;',
      'TEL;type=CELL;type=VOICE;waid=971501234567:+971 50 123 4567',
      'TEL;type=WORK:+971 4 000 0000',
      'EMAIL;type=INTERNET:ahmed@dargol.ae',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcard(vcard)).toEqual({
      name: 'Ahmed Al Mansoori',
      phones: ['+971 50 123 4567', '+971 4 000 0000'],
      emails: ['ahmed@dargol.ae'],
      org: 'Dargol Logistics FZE',
    });
  });

  it('falls back to N, then to the first phone, for the name', () => {
    expect(
      parseVcard('BEGIN:VCARD\nN:Khan;Fatima;;;\nTEL:+971500000001\nEND:VCARD')
        ?.name
    ).toBe('Fatima Khan');
    expect(parseVcard('BEGIN:VCARD\nTEL:+971500000001\nEND:VCARD')).toEqual({
      name: '+971500000001',
      phones: ['+971500000001'],
      emails: [],
      org: null,
    });
  });

  it('unfolds continuation lines and de-duplicates numbers', () => {
    const vcard =
      'BEGIN:VCARD\nFN:Long Name That\n  Wraps\nTEL:+1 555 0100\nTEL:+1 555 0100\nEND:VCARD';
    expect(parseVcard(vcard)).toMatchObject({
      name: 'Long Name That Wraps',
      phones: ['+1 555 0100'],
    });
  });

  it('returns null for a card with neither a name nor a number', () => {
    expect(parseVcard('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD')).toBeNull();
  });
});

describe('metaContactToShared', () => {
  it("maps the Cloud API's structured contact", () => {
    expect(
      metaContactToShared({
        name: { formatted_name: 'Ahmed Al Mansoori', first_name: 'Ahmed' },
        phones: [
          { phone: '+971 50 123 4567', type: 'CELL', wa_id: '971501234567' },
          { wa_id: '971400000000' },
        ],
        emails: [{ email: 'ahmed@dargol.ae' }],
        org: { company: 'Dargol Logistics FZE' },
      })
    ).toEqual({
      name: 'Ahmed Al Mansoori',
      phones: ['+971 50 123 4567', '+971400000000'],
      emails: ['ahmed@dargol.ae'],
      org: 'Dargol Logistics FZE',
    });
  });

  it('builds a name from first/last when formatted_name is absent', () => {
    expect(
      metaContactToShared({
        name: { first_name: 'Fatima', last_name: 'Khan' },
        phones: [{ phone: '+971500000001' }],
      })?.name
    ).toBe('Fatima Khan');
  });
});

describe('contactCardsText', () => {
  it('lists the names for the conversation preview', () => {
    expect(
      contactCardsText([
        { name: 'A', phones: [], emails: [], org: null },
        { name: 'B', phones: [], emails: [], org: null },
      ])
    ).toBe('Contact: A, B');
    expect(
      contactCardsText([{ name: '', phones: ['+1'], emails: [], org: null }])
    ).toBe('Contact card');
  });
});
