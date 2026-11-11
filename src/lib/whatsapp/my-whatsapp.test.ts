import { describe, expect, it } from 'vitest';

import {
  isPersonalNumberRefusal,
  myWhatsAppView,
  parsePersonalNumberInfo,
  routableNumbers,
  importLine,
  isImportActive,
  type PersonalImportProgress,
} from './my-whatsapp';

const job = (
  over: Partial<PersonalImportProgress>
): PersonalImportProgress => ({
  status: 'running',
  chats_done: 3,
  chats_total: 10,
  messages_imported: 120,
  last_error: null,
  finished_at: null,
  ...over,
});

describe('import progress', () => {
  it('picks the line per status', () => {
    expect(importLine(null)).toBeNull();
    expect(importLine(job({ status: 'queued' }))).toEqual({ key: 'preparing' });
    expect(importLine(job({ status: 'listing' }))).toEqual({
      key: 'preparing',
    });
    expect(importLine(job({}))).toEqual({
      key: 'running',
      done: 3,
      total: 10,
      messages: 120,
    });
    expect(importLine(job({ status: 'paused' }))).toEqual({ key: 'paused' });
    expect(importLine(job({ status: 'done', chats_done: 10 }))).toEqual({
      key: 'done',
      total: 10,
      messages: 120,
    });
  });

  it('shortens a failure and never shows an empty one', () => {
    const long = importLine(
      job({ status: 'failed', last_error: 'x'.repeat(300) })
    );
    expect(long).toEqual({ key: 'failed', error: 'x'.repeat(120) });
    expect(importLine(job({ status: 'failed', last_error: ' ' }))).toEqual({
      key: 'failed',
      error: 'unknown error',
    });
  });

  it('polls only while the import is moving', () => {
    for (const s of ['queued', 'listing', 'running'] as const) {
      expect(isImportActive(job({ status: s }))).toBe(true);
    }
    for (const s of ['paused', 'done', 'failed'] as const) {
      expect(isImportActive(job({ status: s }))).toBe(false);
    }
    expect(isImportActive(null)).toBe(false);
  });

  it('parses the route body and drops a bad status', () => {
    const body = (imp: unknown) => ({
      allowed: true,
      configured: true,
      number,
      import: imp,
    });
    expect(
      parsePersonalNumberInfo(
        body({ status: 'running', chats_done: 2, chats_total: 5 })
      )?.import
    ).toEqual(job({ chats_done: 2, chats_total: 5, messages_imported: 0 }));
    expect(
      parsePersonalNumberInfo(body({ status: 'bogus' }))?.import
    ).toBeNull();
  });
});

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
      myWhatsAppView({
        allowed: false,
        configured: true,
        number: null,
        import: null,
      })
    ).toEqual({ kind: 'hidden' });
  });

  it('says OpenWA is missing before offering Connect', () => {
    expect(
      myWhatsAppView({
        allowed: true,
        configured: false,
        number: null,
        import: null,
      })
    ).toEqual({ kind: 'notConfigured' });
  });

  it('offers Connect to an allowed person with no number', () => {
    expect(
      myWhatsAppView({
        allowed: true,
        configured: true,
        number: null,
        import: null,
      })
    ).toEqual({ kind: 'connect' });
  });

  it('shows a number even when the permission was withdrawn', () => {
    expect(
      myWhatsAppView({
        allowed: false,
        configured: false,
        number,
        import: null,
      })
    ).toEqual({ kind: 'connected', number });
  });
});

describe('parsePersonalNumberInfo', () => {
  it('reads the route body', () => {
    expect(
      parsePersonalNumberInfo({
        allowed: true,
        configured: true,
        number,
        import: null,
      })
    ).toEqual({ allowed: true, configured: true, number, import: null });
  });

  it('rejects an error body', () => {
    expect(parsePersonalNumberInfo({ error: 'not_allowed' })).toBeNull();
    expect(parsePersonalNumberInfo(null)).toBeNull();
  });

  it('treats a malformed number as none', () => {
    expect(
      parsePersonalNumberInfo({ allowed: true, configured: true, number: {} })
    ).toEqual({ allowed: true, configured: true, number: null, import: null });
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
