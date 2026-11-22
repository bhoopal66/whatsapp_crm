import { afterEach, describe, expect, it } from 'vitest';

import {
  docTypeLabel,
  docTypeOptions,
  humaniseDocKey,
  mergeDocTypes,
  registerDocTypes,
} from './doc-types';

afterEach(() => registerDocTypes([]));

describe('humaniseDocKey', () => {
  it('makes a key readable', () => {
    expect(humaniseDocKey('trade_licence')).toBe('Trade licence');
    expect(humaniseDocKey('owner_id_copy')).toBe('Owner ID copy');
    expect(humaniseDocKey('  EJARI ')).toBe('Ejari');
    expect(humaniseDocKey('vat-cert')).toBe('VAT cert');
  });
  it('never returns an underscore id', () => {
    expect(humaniseDocKey('some_new_doc_9')).toBe('Some new doc 9');
  });
});

describe('docTypeLabel', () => {
  it('prefers the workspace label, then the built-in, then the key made readable', () => {
    expect(docTypeLabel('trade_licence')).toBe('Trade licence');
    registerDocTypes([{ key: 'trade_licence', label: 'Trade licence copy' }]);
    expect(docTypeLabel('trade_licence')).toBe('Trade licence copy');
    expect(docTypeLabel('board_resolution')).toBe('Board resolution');
  });
  it('is empty for nothing', () => {
    expect(docTypeLabel(null)).toBe('');
    expect(docTypeLabel(undefined)).toBe('');
    expect(docTypeLabel('')).toBe('');
  });
});

describe('mergeDocTypes', () => {
  it('takes the first label per key, adds spec-only keys, sorts by label', () => {
    const out = mergeDocTypes(
      [
        { key: 'passport', label: 'Passport copy' },
        { key: 'ejari', label: '  ' },
        { key: 'passport', label: 'Other label' },
        { key: 'Bad Key', label: 'x' },
        { key: 'trade_licence', label: 'Trade licence' },
      ],
      ['moa', 'passport', 42, 'BAD']
    );
    expect(out).toEqual([
      { key: 'ejari', label: 'Ejari' },
      { key: 'moa', label: 'Memorandum of association' },
      { key: 'passport', label: 'Passport copy' },
      { key: 'trade_licence', label: 'Trade licence' },
    ]);
  });
});

describe('docTypeOptions', () => {
  const types = [{ key: 'ejari', label: 'Ejari' }];
  it('lists labels as options', () => {
    expect(docTypeOptions(types, '')).toEqual([
      { value: 'ejari', label: 'Ejari' },
    ]);
  });
  it('keeps a chosen value that is not in the list, labelled', () => {
    expect(docTypeOptions(types, 'trade_licence')[0]).toEqual({
      value: 'trade_licence',
      label: 'Trade licence',
    });
  });
});
