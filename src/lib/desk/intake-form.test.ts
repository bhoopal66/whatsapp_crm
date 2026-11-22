import { describe, expect, it } from 'vitest';

import {
  formatAge,
  mergeCaption,
  newIdemKey,
  queueReasonKey,
  sameCompany,
} from './intake-form';
import type { ItemTags } from './store';

const empty: ItemTags = {
  kind: null,
  bankCode: null,
  caseRef: null,
  companyName: null,
  tradeLicence: null,
  product: null,
  contactId: null,
  docKey: null,
  note: null,
};

describe('mergeCaption', () => {
  it('fills a pending document from the caption', () => {
    expect(mergeCaption(empty, '4271RAKD trade licence')).toEqual({
      tags: {
        ...empty,
        kind: 'pending_doc',
        caseRef: '4271RAKD',
        docKey: 'trade_licence',
      },
      deskCode: null,
    });
  });

  it('never overrides a form field', () => {
    const tags = {
      ...empty,
      kind: 'info' as const,
      caseRef: '1RAK1',
      note: 'typed',
    };
    // Only the field the form left empty (docKey) is filled.
    expect(mergeCaption(tags, '4271RAKD ejari').tags).toEqual({
      ...tags,
      docKey: 'ejari',
    });
  });

  it('asks to map a NEW caption desk code only when the form named no bank', () => {
    expect(mergeCaption(empty, 'NEW RAK Kite Trading 123456')).toEqual({
      tags: {
        ...empty,
        kind: 'new_case',
        companyName: 'Kite Trading',
        tradeLicence: '123456',
      },
      deskCode: 'RAK',
    });
    expect(
      mergeCaption({ ...empty, bankCode: 'ENBD' }, 'NEW RAK Kite 123456')
        .deskCode
    ).toBeNull();
  });

  it('keeps an unparsed caption as the note', () => {
    expect(mergeCaption(empty, 'licence copy').tags.note).toBe('licence copy');
    expect(mergeCaption(empty, '  ')).toEqual({ tags: empty, deskCode: null });
    expect(mergeCaption(empty, null)).toEqual({ tags: empty, deskCode: null });
  });
});

describe('desk helpers', () => {
  it('labels queue reasons', () => {
    expect(queueReasonKey('NO_CONTACT')).toBe('NO_CONTACT');
    expect(queueReasonKey('LEAD_INVALID')).toBe('OTHER');
    expect(queueReasonKey(null)).toBeNull();
  });

  it('compares company names like the SQL', () => {
    expect(sameCompany(' Kite  General Trading ', 'kite general trading')).toBe(
      true
    );
    expect(sameCompany('Kite', 'Kite LLC')).toBe(false);
    expect(sameCompany('', '')).toBe(false);
  });

  it('makes idempotency keys the SQL accepts', () => {
    expect(newIdemKey(() => '0b8f0c8e-1111-4222-8333-944444444444')).toMatch(
      /^[A-Za-z0-9_:.-]{8,80}$/
    );
  });

  it('formats ages', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(42)).toBe('42s');
    expect(formatAge(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatAge(72 * 3600)).toBe('3d');
    expect(formatAge(3 * 3600 + 120, 'ar')).toBe('3 س 2 د');
  });
});
