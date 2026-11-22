import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_HANDOFF_KEY,
  AUDIENCE_HANDOFF_MAX_AGE_MS,
  buildHandoffRows,
  parseAudienceHandoff,
  readAudienceHandoff,
  writeAudienceHandoff,
  type HandoffStorage,
} from './audience-handoff';

function memory(): HandoffStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('buildHandoffRows', () => {
  it('drops blank and duplicate numbers', () => {
    const rows = buildHandoffRows([
      { phone: '+971 50 123 4401', name: 'A', email: 'a@x.ae' },
      { phone: '971501234401', name: 'dup' },
      { phone: '  ', name: 'blank' },
      { phone: null },
      { phone: '14155552671', company: 'Co' },
    ]);
    expect(rows.map((r) => r.phone)).toEqual([
      '+971 50 123 4401',
      '14155552671',
    ]);
    expect(rows[0].values).toEqual({
      phone: '+971 50 123 4401',
      name: 'A',
      email: 'a@x.ae',
    });
  });
});

describe('write / read', () => {
  it('round-trips and consumes by default', () => {
    const s = memory();
    expect(
      writeAudienceHandoff(s, [{ phone: '14155552671' }], 'contacts', 1000)
    ).toBe(true);
    const got = readAudienceHandoff(s, { now: 2000 });
    expect(got?.rows).toHaveLength(1);
    expect(s.map.has(AUDIENCE_HANDOFF_KEY)).toBe(false);
    expect(readAudienceHandoff(s, { now: 2000 })).toBeNull();
  });
  it('can peek without clearing', () => {
    const s = memory();
    writeAudienceHandoff(s, [{ phone: '14155552671' }], 'contacts', 1000);
    expect(
      readAudienceHandoff(s, { consume: false, now: 1001 })
    ).not.toBeNull();
    expect(s.map.has(AUDIENCE_HANDOFF_KEY)).toBe(true);
  });
  it('writes nothing for no usable rows or no storage', () => {
    expect(writeAudienceHandoff(memory(), [{ phone: '' }])).toBe(false);
    expect(writeAudienceHandoff(null, [{ phone: '14155552671' }])).toBe(false);
  });
});

describe('parseAudienceHandoff', () => {
  it('rejects garbage, wrong versions, stale and empty payloads', () => {
    expect(parseAudienceHandoff(null)).toBeNull();
    expect(parseAudienceHandoff('not json')).toBeNull();
    expect(
      parseAudienceHandoff('{"v":2,"rows":[],"createdAt":1}', 2)
    ).toBeNull();
    const rows = [{ phone: '14155552671', values: {} }];
    const fresh = JSON.stringify({ v: 1, source: 's', createdAt: 1000, rows });
    expect(
      parseAudienceHandoff(fresh, 1000 + AUDIENCE_HANDOFF_MAX_AGE_MS + 1)
    ).toBeNull();
    expect(parseAudienceHandoff(fresh, 1500)?.rows).toHaveLength(1);
    const bad = JSON.stringify({
      v: 1,
      createdAt: 1000,
      rows: [{ phone: 5 }, null],
    });
    expect(parseAudienceHandoff(bad, 1500)).toBeNull();
  });
  it('is tolerant of a storage that throws', () => {
    const s: HandoffStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(readAudienceHandoff(s)).toBeNull();
    expect(writeAudienceHandoff(s, [{ phone: '14155552671' }])).toBe(false);
  });
});
