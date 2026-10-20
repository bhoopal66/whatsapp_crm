import { describe, expect, it } from 'vitest';

import {
  isBankCode,
  isBankCodeList,
  isUuid,
  mapCoordinatorError,
} from './errors';

describe('validators', () => {
  it('checks uuids', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(5)).toBe(false);
  });
  it('checks bank codes', () => {
    expect(isBankCode('ADCB')).toBe(true);
    expect(isBankCode('A')).toBe(false);
    expect(isBankCode('adcb')).toBe(false);
    expect(isBankCode('A'.repeat(33))).toBe(false);
  });
  it('checks code lists', () => {
    expect(isBankCodeList([])).toBe(true);
    expect(isBankCodeList(['ADCB', 'FAB'])).toBe(true);
    expect(isBankCodeList(['ADCB', 'ADCB'])).toBe(false);
    expect(isBankCodeList(['bad'])).toBe(false);
    expect(isBankCodeList('ADCB')).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `BANK_${i}`);
    expect(isBankCodeList(many)).toBe(false);
    expect(isBankCodeList(many.slice(0, 50))).toBe(true);
  });
});

describe('mapCoordinatorError', () => {
  it('maps hints on 22023', () => {
    expect(
      mapCoordinatorError({ code: '22023', hint: 'not_eligible' }).status
    ).toBe(400);
    expect(
      mapCoordinatorError({ code: '22023', hint: 'unknown_bank' }).error
    ).toMatch(/bank/);
    expect(mapCoordinatorError({ code: '22023' }).status).toBe(400);
  });
  it('maps permission and not found', () => {
    expect(mapCoordinatorError({ code: '42501' }).status).toBe(403);
    expect(mapCoordinatorError({ code: 'P0002' }).status).toBe(404);
  });
  it('never leaks raw text', () => {
    const m = mapCoordinatorError({
      code: 'XX000',
      message: 'relation "secret" does not exist',
    });
    expect(m.status).toBe(500);
    expect(m.error).not.toMatch(/secret/);
  });
});
