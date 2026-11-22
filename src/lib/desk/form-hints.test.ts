import { describe, expect, it } from 'vitest';

import {
  newCaseMissing,
  rejectBlock,
  sortFileBlock,
  trayDismissBlock,
  trayFileBlock,
  uploadBlock,
} from './form-hints';

describe('uploadBlock', () => {
  it('asks for the file of a pending document only', () => {
    expect(uploadBlock({ kind: 'pending_doc', hasFile: false })).toBe(
      'fileNeeded'
    );
    expect(uploadBlock({ kind: 'pending_doc', hasFile: true })).toBeNull();
    expect(uploadBlock({ kind: 'info', hasFile: false })).toBeNull();
    expect(uploadBlock({ kind: '', hasFile: false })).toBeNull();
  });
});

describe('sortFileBlock', () => {
  it('needs a found case, then the typed confirmation on a mismatch', () => {
    expect(
      sortFileBlock({ found: false, mismatch: false, confirmed: false })
    ).toBe('noCase');
    expect(
      sortFileBlock({ found: true, mismatch: true, confirmed: false })
    ).toBe('confirm');
    expect(
      sortFileBlock({ found: true, mismatch: true, confirmed: true })
    ).toBeNull();
    expect(
      sortFileBlock({ found: true, mismatch: false, confirmed: false })
    ).toBeNull();
  });
});

describe('newCaseMissing', () => {
  it('lists every missing field in form order', () => {
    expect(
      newCaseMissing({
        legalName: ' ',
        licence: '',
        bankCode: '',
        product: '',
        hasContact: false,
      })
    ).toEqual(['company', 'licence', 'bank', 'product', 'contact']);
  });
  it('is empty when complete', () => {
    expect(
      newCaseMissing({
        legalName: 'Kite',
        licence: '123',
        bankCode: 'RAK',
        product: 'Loan',
        hasContact: true,
      })
    ).toEqual([]);
  });
});

describe('reasons', () => {
  it('rejects blank reasons', () => {
    expect(rejectBlock('  ')).toBe('reason');
    expect(rejectBlock('duplicate')).toBeNull();
  });
  it('tray filing needs a pick and, when asked, a typed name', () => {
    expect(
      trayFileBlock({ picked: false, mustConfirm: false, confirm: '' })
    ).toBe('pick');
    expect(
      trayFileBlock({ picked: true, mustConfirm: true, confirm: ' ' })
    ).toBe('confirm');
    expect(
      trayFileBlock({ picked: true, mustConfirm: true, confirm: 'Kite' })
    ).toBeNull();
    expect(
      trayFileBlock({ picked: true, mustConfirm: false, confirm: '' })
    ).toBeNull();
  });
  it('tray dismissing needs three characters', () => {
    expect(trayDismissBlock('ab')).toBe('reason');
    expect(trayDismissBlock('  a ')).toBe('reason');
    expect(trayDismissBlock('dup')).toBeNull();
  });
});
