import { describe, expect, it } from 'vitest';

import {
  isPersonalNumberRefusal,
  myWhatsAppView,
  parsePersonalNumberInfo,
  routableNumbers,
} from './my-whatsapp';

const number = {
  id: 'c1',
  label: 'Mine',
  status: 'connected',
  phone: '971500000000',
  connected_at: '2026-11-11T00:00:00Z',
  created_at: '2026-11-11T00:00:00Z',
};

describe('myWhatsAppView', () => {
  it('hides the card when the read failed or was refused', () => {
    expect(myWhatsAppView(null)).toEqual({ kind: 'hidden' });
  });

  it('hides it from someone not allowed and with no number', () => {
    expect(
      myWhatsAppView({ allowed: false, configured: true, number: null })
    ).toEqual({ kind: 'hidden' });
  });

  it('says OpenWA is missing before offering Connect', () => {
    expect(
      myWhatsAppView({ allowed: true, configured: false, number: null })
    ).toEqual({ kind: 'notConfigured' });
  });

  it('offers Connect to an allowed person with no number', () => {
    expect(
      myWhatsAppView({ allowed: true, configured: true, number: null })
    ).toEqual({ kind: 'connect' });
  });

  it('shows a number even when the permission was withdrawn', () => {
    expect(
      myWhatsAppView({ allowed: false, configured: false, number })
    ).toEqual({ kind: 'connected', number });
  });
});

describe('parsePersonalNumberInfo', () => {
  it('reads the route body', () => {
    expect(
      parsePersonalNumberInfo({ allowed: true, configured: true, number })
    ).toEqual({ allowed: true, configured: true, number });
  });

  it('rejects an error body', () => {
    expect(parsePersonalNumberInfo({ error: 'not_allowed' })).toBeNull();
    expect(parsePersonalNumberInfo(null)).toBeNull();
  });

  it('treats a malformed number as none', () => {
    expect(
      parsePersonalNumberInfo({ allowed: true, configured: true, number: {} })
    ).toEqual({ allowed: true, configured: true, number: null });
  });
});

describe('isPersonalNumberRefusal', () => {
  it('matches only the 409 personal_number code', () => {
    expect(isPersonalNumberRefusal(409, { code: 'personal_number' })).toBe(
      true
    );
    expect(isPersonalNumberRefusal(400, { code: 'personal_number' })).toBe(
      false
    );
    expect(isPersonalNumberRefusal(409, { code: 'shared_chat_number' })).toBe(
      false
    );
    expect(isPersonalNumberRefusal(409, null)).toBe(false);
  });
});

describe('routableNumbers', () => {
  it('leaves personal numbers out', () => {
    const rows = [
      { id: 'a', is_personal: false },
      { id: 'b', is_personal: true },
      { id: 'c' },
    ];
    expect(routableNumbers(rows).map((r) => r.id)).toEqual(['a', 'c']);
  });
});
