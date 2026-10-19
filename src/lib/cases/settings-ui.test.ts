import { describe, expect, it } from 'vitest';

import {
  configErrorKey,
  configErrorText,
  groupByProduct,
  keyFromLabel,
  moveStage,
  removeStage,
  slaCellLabel,
  slaRowFor,
  stagesBody,
  validateStages,
} from './settings-ui';

// 122's case_default_stages().
const DEFAULTS = [
  'Submitted',
  'Bank acknowledged',
  'Documents requested',
  'Documents received',
  'Under review',
  'Query raised',
  'Query answered',
  'Approved',
  'Declined',
  'Withdrawn',
  'Closed',
];

describe('moveStage', () => {
  it('swaps a stage with its neighbour', () => {
    expect(moveStage(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveStage(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('leaves the list alone at either end or out of range', () => {
    expect(moveStage(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveStage(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveStage(['a', 'b'], 5, -1)).toEqual(['a', 'b']);
  });

  it('never mutates its input', () => {
    const list = ['a', 'b'];
    moveStage(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });
});

describe('removeStage', () => {
  it('drops only the stage at the index', () => {
    expect(removeStage(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeStage(['a'], 3)).toEqual(['a']);
  });
});

describe('validateStages (mirrors 122 case_bank_stages_check)', () => {
  it('accepts the default list and a shorter valid one', () => {
    expect(validateStages(DEFAULTS)).toBeNull();
    expect(
      validateStages(['New', 'Approved', 'Declined', 'Withdrawn', 'Closed'])
    ).toBeNull();
  });

  it('reports an empty list (that is a reset, not a save)', () => {
    expect(validateStages([])).toEqual({ kind: 'empty' });
  });

  it('refuses more than 50 stages', () => {
    const many = [
      ...Array.from({ length: 47 }, (_, i) => `Step ${i}`),
      'Approved',
      'Declined',
      'Withdrawn',
      'Closed',
    ];
    expect(validateStages(many)).toEqual({ kind: 'tooMany', max: 50 });
  });

  it('refuses a blank or over-long name, by position', () => {
    expect(validateStages(['New', '  ', ...DEFAULTS.slice(7)])).toEqual({
      kind: 'blank',
      position: 2,
    });
    expect(validateStages(['x'.repeat(101), ...DEFAULTS.slice(7)])).toEqual({
      kind: 'tooLong',
      position: 1,
      max: 100,
    });
  });

  it('refuses the same stage twice, after trimming', () => {
    expect(validateStages(['New', ' New ', ...DEFAULTS.slice(7)])).toEqual({
      kind: 'duplicate',
      stage: 'New',
    });
  });

  it('refuses a final stage first, in any case', () => {
    expect(validateStages(['closed', 'New', ...DEFAULTS.slice(7, 10)])).toEqual(
      { kind: 'firstFinal', stage: 'closed' }
    );
  });

  it('refuses a list missing any of the four finals', () => {
    for (const final of ['Approved', 'Declined', 'Withdrawn', 'Closed']) {
      const list = DEFAULTS.filter((s) => s !== final);
      expect(validateStages(list)).toEqual({
        kind: 'missingFinal',
        stage: final,
      });
    }
  });

  it('asks for the exact spelling of a final stage', () => {
    const list = DEFAULTS.map((s) => (s === 'Withdrawn' ? 'withdrawn' : s));
    expect(validateStages(list)).toEqual({
      kind: 'finalSpelling',
      stage: 'Withdrawn',
    });
  });
});

describe('stagesBody', () => {
  it('sends the trimmed list', () => {
    expect(stagesBody([' New ', 'Closed'])).toEqual({
      stages: ['New', 'Closed'],
    });
  });
});

describe('configErrorKey', () => {
  it('maps every 422 code of the config routes', () => {
    expect(configErrorKey({ code: 'STAGE_IN_USE' })).toBe('stageInUse');
    expect(configErrorKey({ code: 'BANK_STAGES_FIRST_FINAL' })).toBe(
      'firstFinal'
    );
    expect(configErrorKey({ code: 'BANK_STAGES_MISSING_FINAL' })).toBe(
      'missingFinal'
    );
    expect(configErrorKey({ code: 'BANK_STAGES_FINAL_SPELLING' })).toBe(
      'finalSpelling'
    );
    expect(configErrorKey({ code: 'STAGE_DUPLICATE' })).toBe('duplicate');
    expect(configErrorKey({ code: 'STAGE_NOT_CONFIGURED' })).toBe(
      'stageNotConfigured'
    );
    expect(configErrorKey({ code: 'INVALID' })).toBe('invalid');
  });

  it('falls back to generic for anything else', () => {
    for (const body of [null, 'x', {}, { code: 'NOPE' }, { code: 7 }])
      expect(configErrorKey(body)).toBe('generic');
  });

  it('reads the error text, else the status', () => {
    expect(configErrorText({ error: 'Bank not found' }, 404)).toBe(
      'Bank not found'
    );
    expect(configErrorText(null, 500)).toBe('HTTP 500');
  });
});

describe('slaCellLabel', () => {
  const row = {
    stage: 'Under review',
    timer: 'bank_response',
    amount: 2,
    unit: 'days' as const,
    dueSoonPct: 20,
    dueSoonMinutes: null,
  };

  it('is none with no row', () => {
    expect(slaCellLabel(null)).toEqual({ kind: 'none' });
    expect(slaCellLabel(undefined)).toEqual({ kind: 'none' });
  });

  it('carries the amount, unit and percentage', () => {
    expect(slaCellLabel(row)).toEqual({
      kind: 'set',
      amount: 2,
      unit: 'days',
      dueSoon: { kind: 'pct', pct: 20 },
    });
  });

  it('prefers fixed minutes over the percentage (124 reads them first)', () => {
    expect(slaCellLabel({ ...row, dueSoonMinutes: 90 }).kind).toBe('set');
    expect(slaCellLabel({ ...row, dueSoonMinutes: 90 })).toMatchObject({
      dueSoon: { kind: 'minutes', minutes: 90 },
    });
  });

  it('finds the row of a cell', () => {
    expect(slaRowFor([row], 'Under review', 'bank_response')).toBe(row);
    expect(slaRowFor([row], 'Under review', 'customer_reply')).toBeNull();
  });
});

describe('groupByProduct', () => {
  it('groups by product and orders by position', () => {
    const rows = [
      { product: 'Mortgage', docKey: 'b', label: 'B', position: 2 },
      { product: 'Card', docKey: 'c', label: 'C', position: 1 },
      { product: 'Mortgage', docKey: 'a', label: 'A', position: 1 },
    ];
    expect(groupByProduct(rows)).toEqual([
      { product: 'Card', documents: [rows[1]] },
      { product: 'Mortgage', documents: [rows[2], rows[0]] },
    ]);
  });
});

describe('keyFromLabel', () => {
  it('proposes a key the routes accept', () => {
    expect(keyFromLabel('Salary certificate (3 months)')).toBe(
      'salary_certificate_3_months'
    );
    expect(keyFromLabel('ﾠ')).toBe('');
  });
});
