import { describe, expect, it } from 'vitest';

import {
  normalizeCompassPhone,
  parseCompassContact,
  parseCompassContactBatch,
  serializeCompassContact,
} from './contacts';

describe('normalizeCompassPhone', () => {
  it('strips formatting down to international digits', () => {
    expect(normalizeCompassPhone('+971 50 123-4567')).toEqual({
      ok: true,
      phone: '971501234567',
    });
  });

  it('accepts a numeric phone from the ERP', () => {
    expect(normalizeCompassPhone(971501234567)).toEqual({
      ok: true,
      phone: '971501234567',
    });
  });

  it('treats missing or blank as "no phone", not an error', () => {
    expect(normalizeCompassPhone(undefined)).toEqual({ ok: true, phone: null });
    expect(normalizeCompassPhone('  ')).toEqual({ ok: true, phone: null });
  });

  it('rejects a local number instead of guessing its country', () => {
    const result = normalizeCompassPhone('050 123 4567');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/country code/);
  });

  it.each([
    ['557123456', /too short/], // 9-digit local mobile, passed E.164
    ['97150123456', /not a valid UAE number/], // mobile missing a digit
    ['9715512345678', /not a valid UAE number/], // one digit too many
    [9.71505e21, /scientific notation/], // ERP numeric overflow
  ])('rejects %s the way the CRM does', (value, message) => {
    const result = normalizeCompassPhone(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^'phone' /);
      expect(result.error).toMatch(message);
    }
  });

  it('drops a trunk 0 kept after +971 and accepts other countries', () => {
    expect(normalizeCompassPhone('+971 050 123 4567')).toEqual({
      ok: true,
      phone: '971501234567',
    });
    expect(normalizeCompassPhone('+961 71 123 456')).toEqual({
      ok: true,
      phone: '96171123456',
    });
  });
});

describe('parseCompassContact', () => {
  it('parses a full record', () => {
    const result = parseCompassContact({
      compass_id: ' CUST-1 ',
      name: ' Jane ',
      phone: '+971501234567',
      email: 'jane@example.com',
      company: 'Acme',
      attributes: { branch: 'Dubai' },
    });
    expect(result).toEqual({
      ok: true,
      row: {
        compass_id: 'CUST-1',
        name: 'Jane',
        phone: '971501234567',
        email: 'jane@example.com',
        company: 'Acme',
        attributes: { branch: 'Dubai' },
      },
    });
  });

  it('stores a numeric compass_id as text', () => {
    const result = parseCompassContact({ compass_id: 42 });
    expect(result.ok && result.row.compass_id).toBe('42');
  });

  it('requires compass_id', () => {
    expect(parseCompassContact({ name: 'x' })).toMatchObject({
      ok: false,
      compassId: null,
    });
  });

  it('reports the compass_id of a record it rejects', () => {
    expect(
      parseCompassContact({ compass_id: 'C9', phone: '0501234567' })
    ).toMatchObject({ ok: false, compassId: 'C9' });
  });

  it('rejects non-object attributes', () => {
    expect(
      parseCompassContact({ compass_id: 'C1', attributes: ['a'] })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/attributes/) });
  });

  it('rejects oversized attributes', () => {
    expect(
      parseCompassContact({
        compass_id: 'C1',
        attributes: { blob: 'x'.repeat(20_000) },
      })
    ).toMatchObject({ ok: false });
  });
});

describe('parseCompassContactBatch', () => {
  it('keeps good records and reports bad ones by index', () => {
    const { rows, rejected } = parseCompassContactBatch([
      { compass_id: 'A', phone: '+971501234567' },
      { compass_id: 'B', phone: 'nope' },
      'not an object',
      { compass_id: 'C' },
    ]);
    expect(rows.map((r) => r.compass_id)).toEqual(['A', 'C']);
    expect(rejected).toEqual([
      { index: 1, compass_id: 'B', error: expect.any(String) },
      { index: 2, compass_id: null, error: 'Record must be an object' },
    ]);
  });

  it('collapses a repeated compass_id to its last occurrence', () => {
    // Postgres refuses an upsert that hits the same row twice in one
    // statement, so this must happen before the query.
    const { rows } = parseCompassContactBatch([
      { compass_id: 'A', name: 'first' },
      { compass_id: 'B', name: 'b' },
      { compass_id: 'A', name: 'second' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.compass_id === 'A')?.name).toBe('second');
  });
});

describe('serializeCompassContact', () => {
  it('does not leak the internal row id', () => {
    const out = serializeCompassContact({
      id: 'internal-uuid',
      compass_id: 'A',
      attributes: null,
      created_at: 't',
      updated_at: 't',
    });
    expect(out).not.toHaveProperty('id');
    expect(out.attributes).toEqual({});
  });
});
