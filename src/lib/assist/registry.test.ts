// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (test/019a/loop.test.ts,
// "019a G6 risk rule").
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_MODES,
  DEFAULT_MODE,
  ToolRegistry,
  needsConfirmation,
} from './registry';

describe('019a G6 risk rule', () => {
  it('DANGEROUS needs confirmation in supervised, cautious and autonomous; WRITE only in supervised', () => {
    expect(AUTONOMY_MODES).toEqual(['supervised', 'cautious', 'autonomous']);
    expect(
      AUTONOMY_MODES.map((m) => needsConfirmation('DANGEROUS', m))
    ).toEqual([true, true, true]);
    expect(AUTONOMY_MODES.map((m) => needsConfirmation('WRITE', m))).toEqual([
      true,
      false,
      false,
    ]);
    expect(AUTONOMY_MODES.map((m) => needsConfirmation('READ', m))).toEqual([
      false,
      false,
      false,
    ]);
    expect(DEFAULT_MODE).toBe('cautious');
  });

  it('an unregistered tool is DANGEROUS', () => {
    const r = new ToolRegistry();
    expect(r.risk('never_registered')).toBe('DANGEROUS');
    expect(r.spec('never_registered')).toEqual({
      risk: 'DANGEROUS',
      registered: false,
      displayName: 'unregistered tool',
    });
    expect(new ToolRegistry({}).risk('search_contacts')).toBe('DANGEROUS');
  });

  it('resolves defaults, shorthand and full specs', () => {
    const d = new ToolRegistry();
    expect(d.risk('search_contacts')).toBe('READ');
    expect(d.risk('send_message')).toBe('WRITE');
    expect(d.risk('delete_contact')).toBe('DANGEROUS');
    const r = new ToolRegistry({
      a: 'READ',
      b: { risk: 'WRITE', displayName: 'Bee' },
    });
    expect(r.spec('a')).toEqual({
      risk: 'READ',
      registered: true,
      displayName: 'a',
    });
    expect(r.spec('b')).toMatchObject({
      risk: 'WRITE',
      registered: true,
      displayName: 'Bee',
    });
  });
});
