import { describe, expect, it } from 'vitest';
import {
  RECYCLE_HANDOFF_TTL_MS,
  buildRecycleHandoff,
  parseRecycleHandoff,
} from './handoff';

describe('recycle handoff', () => {
  const now = 1_800_000_000_000;

  it('round-trips into the wizard CSV audience, deduped by number', () => {
    const raw = buildRecycleHandoff(
      [
        { phone: '971501234567', name: 'Sara' },
        { phone: '+971 50 123 4567', name: 'Dup' },
        { phone: '971509999999', name: null },
        { phone: ' ', name: 'blank' },
      ],
      now
    );
    const a = parseRecycleHandoff(raw, now + 1000);
    expect(a?.type).toBe('csv');
    expect(a?.csvContacts).toHaveLength(2);
    expect(a?.csvContacts?.[0]).toMatchObject({
      phone: '971501234567',
      name: 'Sara',
    });
    expect(a?.csvContacts?.[1].name).toBeUndefined();
  });

  it('refuses stale, empty, future and malformed handoffs', () => {
    const raw = buildRecycleHandoff([{ phone: '971501234567' }], now);
    expect(
      parseRecycleHandoff(raw, now + RECYCLE_HANDOFF_TTL_MS + 1)
    ).toBeNull();
    expect(parseRecycleHandoff(raw, now - 120_000)).toBeNull();
    expect(parseRecycleHandoff(buildRecycleHandoff([], now), now)).toBeNull();
    expect(parseRecycleHandoff('{', now)).toBeNull();
    expect(parseRecycleHandoff(null, now)).toBeNull();
    expect(parseRecycleHandoff('{"at":1,"contacts":5}', now)).toBeNull();
  });
});
