import { describe, expect, it } from 'vitest';

import { buildChecklist, checklistText, type ReviewFile } from './checklist';

const NOW = new Date('2026-11-21T08:00:00Z');
const req = [
  { docKey: 'passport', label: 'Passport', position: 1, required: true },
  {
    docKey: 'trade_licence',
    label: 'Trade licence',
    position: 2,
    required: true,
  },
  { docKey: 'ejari', label: 'Ejari', position: 3, required: false },
  {
    docKey: 'bank_statement',
    label: 'Bank statement',
    position: 4,
    required: true,
  },
  { docKey: 'moa', label: 'MOA', position: 5, required: true },
];
const file = (over: Partial<ReviewFile>): ReviewFile => ({
  fileId: 'f',
  docKey: null,
  version: 1,
  identity: 'x',
  status: 'passed',
  checks: [],
  expiresOn: null,
  ...over,
});

describe('buildChecklist', () => {
  it('states each required document and flags disagreements', () => {
    const c = buildChecklist(
      req,
      [
        { docKey: 'passport', status: 'received' },
        { docKey: 'moa', status: 'rejected' },
        { docKey: 'bank_statement', status: 'received' },
      ],
      [
        file({
          fileId: 'p1',
          docKey: 'passport',
          identity: 'a',
          expiresOn: '2026-01-01',
        }),
        file({
          fileId: 't1',
          docKey: 'trade_licence',
          identity: 'b',
          version: 1,
        }),
        file({
          fileId: 't2',
          docKey: 'trade_licence',
          identity: 'c',
          version: 2,
          status: 'failed',
          checks: [
            { name: 'readable', ok: false },
            { name: 'mime', ok: true },
          ],
        }),
        file({
          fileId: 'u1',
          docKey: null,
          identity: 'd',
          status: 'unclassified',
        }),
        file({ fileId: 'x1', docKey: 'visa', identity: 'a' }),
        file({
          fileId: 's1',
          docKey: 'passport',
          identity: 'z',
          status: 'superseded',
        }),
      ],
      NOW
    );
    expect(c.items.map((i) => [i.docKey, i.state])).toEqual([
      ['passport', 'expired'],
      ['trade_licence', 'failed'],
      ['ejari', 'missing'],
      ['bank_statement', 'received'],
      ['moa', 'rejected'],
    ]);
    expect(c.items[1]!.failedChecks).toEqual(['readable']);
    expect(c.flags.map((f) => f.code).sort()).toEqual(
      [
        'DUPLICATE_FILE',
        'PASSED_FILE_NOT_RECEIVED',
        'RECEIVED_WITHOUT_PASSED_FILE',
        'UNCLASSIFIED_FILES',
        'UNEXPECTED_DOCUMENT',
      ].sort()
    );
  });

  it('writes the checklist as text', () => {
    const c = buildChecklist(
      req.slice(0, 2),
      [{ docKey: 'passport', status: 'received' }],
      [file({ fileId: 'p', docKey: 'passport' })],
      NOW
    );
    expect(checklistText(c)).toBe(
      '1 of 2 required documents received.\n- Passport (passport): received\n- Trade licence (trade_licence): missing'
    );
  });
});
