import { describe, expect, it } from 'vitest';
import {
  clampDays,
  daysSince,
  formatPhone,
  mapRecycleRow,
  recycleTaskRef,
  settingsFromRow,
  whyKey,
} from './rows';

describe('recycle rows', () => {
  it('maps an rpc row and tolerates a string count', () => {
    const r = mapRecycleRow({
      contact_id: 'c1',
      name: '  Sara ',
      phone: '971501234567',
      owner_id: 'u1',
      owner_name: ' ',
      source: 'chat',
      case_id: null,
      conversation_id: 'v1',
      bank_code: null,
      outcome: null,
      reason_code: null,
      chat_tag_name: 'Not interested',
      ended_at: '2026-01-01T00:00:00Z',
      total_count: '7',
    });
    expect(r.name).toBe('Sara');
    expect(r.ownerName).toBeNull();
    expect(r.source).toBe('chat');
    expect(r.total).toBe(7);
  });

  it('counts whole days and never goes negative', () => {
    const now = new Date('2026-04-11T12:00:00Z');
    expect(daysSince('2026-01-01T12:00:00Z', now)).toBe(100);
    expect(daysSince('2027-01-01T00:00:00Z', now)).toBe(0);
    expect(daysSince('nope', now)).toBe(0);
  });

  it('formats UAE and other numbers', () => {
    expect(formatPhone('971501234567')).toBe('+971 50 123 4567');
    expect(formatPhone('12')).toBe('12');
  });

  it('picks the why-listed key', () => {
    expect(whyKey({ source: 'chat', outcome: null })).toBe('chatTag');
    expect(whyKey({ source: 'case', outcome: 'Withdrawn' })).toBe(
      'caseWithdrawn'
    );
    expect(whyKey({ source: 'case', outcome: 'Declined' })).toBe(
      'caseDeclined'
    );
  });

  it('clamps days into 1..730', () => {
    expect(clampDays('0')).toBe(1);
    expect(clampDays(9999)).toBe(730);
    expect(clampDays('abc')).toBe(90);
    expect(clampDays(45.9)).toBe(45);
  });

  it('reads settings with defaults and drops unknown outcomes', () => {
    expect(settingsFromRow(null).days).toBe(90);
    const s = settingsFromRow({
      days: 30,
      chat_tag_ids: ['t'],
      case_outcomes: ['Declined', 'Approved'],
    });
    expect(s).toEqual({
      days: 30,
      chatTagIds: ['t'],
      caseOutcomes: ['Declined'],
    });
  });

  it('builds the same task ref as the SQL (UTC date)', () => {
    expect(recycleTaskRef('abc', '2026-01-05T23:30:00-05:00')).toBe(
      'recycle:abc:2026-01-06'
    );
  });
});
