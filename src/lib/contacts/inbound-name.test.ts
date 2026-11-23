import { describe, expect, it } from 'vitest';
import { shouldRenameContact } from './inbound-name';

const PHONE = '971504555843';
const rename = (stored: string | null, incoming: string, phone = PHONE) =>
  shouldRenameContact({ name: stored, phone }, PHONE, incoming);

describe('shouldRenameContact', () => {
  it.each(['Ahmed - ABC Trading LLC', 'Asha', 'Ahmed 971504555843'])(
    'keeps the stored name %s',
    (stored) => expect(rename(stored, 'Ahmed')).toBe(false)
  );

  it.each([null, '', '   '])('fills an empty name (%j)', (stored) =>
    expect(rename(stored, 'Ahmed')).toBe(true)
  );

  it.each([
    PHONE,
    '+971 50 455 5843',
    '+971 (0)50 455 5843',
    '0971504555843',
    '050 455 5843',
  ])("replaces the contact's own number %s", (stored) =>
    expect(rename(stored, 'Ahmed')).toBe(true)
  );

  it('replaces the sender number on a row saved in a local form', () => {
    expect(rename(PHONE, 'Ahmed', '050 455 5843')).toBe(true);
  });

  it("keeps someone else's number", () => {
    expect(rename('+966 50 455 5843', 'Ahmed')).toBe(false);
  });

  it.each([PHONE, '+971 50 455 5843', '‪+971 50‬ 4555843', ' ', ''])(
    'never renames to %j',
    (incoming) => {
      expect(rename(PHONE, incoming)).toBe(false);
      expect(rename(null, incoming)).toBe(false);
    }
  );
});
