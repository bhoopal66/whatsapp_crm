import { describe, expect, it } from 'vitest';

import { parseKbTable, pickKbSheet } from './import';

const HEADER = [
  'ID',
  'Audience',
  'Category',
  'Question (as a user would ask)',
  'Bot answer',
  'Source',
  'Status',
  'Reviewer comments / flags',
];

/** A row in HEADER's column order. */
function r(
  id: string,
  audience: string,
  question: string,
  answer: string,
  status = 'Approved',
  extra: { category?: string; source?: string; notes?: string } = {}
): string[] {
  return [
    id,
    audience,
    extra.category ?? 'General',
    question,
    answer,
    extra.source ?? '',
    status,
    extra.notes ?? '',
  ];
}

describe('parseKbTable', () => {
  it('reads the review sheet below a title, with 1-based sheet rows', () => {
    const { rows, issues } = parseKbTable([
      ['Taamul chatbot knowledge base'],
      [],
      HEADER,
      r(
        ' kb-001 ',
        'Prospective client',
        'What do you do?',
        ' We help. ',
        'Approved',
        {
          source: 'Website',
          notes: 'ok',
        }
      ),
    ]);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        ref: 'KB-001',
        audience: 'prospective_client',
        category: 'General',
        question: 'What do you do?',
        answer_en: 'We help.',
        source: 'Website',
        status: 'approved',
        reviewer_notes: 'ok',
        row: 4,
      },
    ]);
  });

  it('maps every status and audience label', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      r('A1', 'Existing client', 'q1', 'a', 'Draft - verify'),
      r('A2', 'internal staff', 'q2', 'a', 'draft'),
      r('A3', 'Prospective client', 'q3', 'a', ''),
      r('A4', 'Prospective client', 'q4', 'a', 'To confirm'),
      r('A5', 'Prospective client', 'q5', 'a', 'Remove'),
      r('A6', 'Prospective client', 'q6', 'a', 'APPROVED'),
    ]);
    expect(issues).toEqual([]);
    expect(rows.map((x) => [x.ref, x.audience, x.status])).toEqual([
      ['A1', 'existing_client', 'draft'],
      ['A2', 'internal_staff', 'draft'],
      ['A3', 'prospective_client', 'draft'],
      ['A4', 'prospective_client', 'to_confirm'],
      ['A5', 'prospective_client', 'remove'],
      ['A6', 'prospective_client', 'approved'],
    ]);
  });

  it('imports an unknown status as draft with an issue', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      r('A1', 'Existing client', 'q', 'a', 'Maybe'),
    ]);
    expect(rows[0].status).toBe('draft');
    expect(issues).toEqual([
      {
        row: 2,
        ref: 'A1',
        message: 'Unknown status "Maybe"; imported as Draft',
        skipped: false,
      },
    ]);
  });

  it('downgrades an approved row with no usable answer to to_confirm', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      r('A1', 'Existing client', 'q1', ''),
      r('A2', 'Existing client', 'q2', 'Fees are [ to confirm with finance]'),
      r(
        'A3',
        'Existing client',
        'q3',
        'Fees are [TO CONFIRM]',
        'Draft - verify'
      ),
    ]);
    expect(rows.map((x) => x.status)).toEqual([
      'to_confirm',
      'to_confirm',
      'draft',
    ]);
    expect(issues.map((i) => [i.row, i.ref, i.skipped])).toEqual([
      [2, 'A1', false],
      [3, 'A2', false],
    ]);
  });

  it('checks an Arabic answer for the placeholder too', () => {
    const { rows } = parseKbTable([
      ['ID', 'Audience', 'Question', 'Answer (EN)', 'Answer (AR)', 'Status'],
      ['A1', 'Existing client', 'q', 'Yes.', '[TO CONFIRM]', 'Approved'],
    ]);
    expect(rows[0].status).toBe('to_confirm');
  });

  it('skips rows without an ID, a question or a known audience', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      r('', 'Existing client', 'q', 'a'),
      r('A2', 'Existing client', '  ', 'a'),
      r('A3', 'Board member', 'q', 'a'),
      r('A4', '', 'q', 'a'),
      r('A5', 'Existing client', 'q', 'a'),
    ]);
    expect(rows.map((x) => x.ref)).toEqual(['A5']);
    expect(issues).toEqual([
      { row: 2, ref: null, message: 'No ID', skipped: true },
      { row: 3, ref: 'A2', message: 'No question', skipped: true },
      {
        row: 4,
        ref: 'A3',
        message: 'Unknown audience "Board member"',
        skipped: true,
      },
      { row: 5, ref: 'A4', message: 'No audience', skipped: true },
    ]);
  });

  it('treats Object.prototype names as unknown values, not table hits', () => {
    const { rows, issues } = parseKbTable([
      [...HEADER, 'Constructor'],
      r('A1', 'constructor', 'q', 'a'),
      r('A2', 'Existing client', 'q', 'a', 'constructor'),
    ]);
    expect(issues).toEqual([
      {
        row: 2,
        ref: 'A1',
        message: 'Unknown audience "constructor"',
        skipped: true,
      },
      {
        row: 3,
        ref: 'A2',
        message: 'Unknown status "constructor"; imported as Draft',
        skipped: false,
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ ref: 'A2', status: 'draft' }),
    ]);
  });

  it('keeps the first of two rows whose IDs differ only in case', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      r('kb-1', 'Existing client', 'first', 'a'),
      r('KB-1 ', 'Existing client', 'second', 'a'),
    ]);
    expect(rows.map((x) => x.question)).toEqual(['first']);
    expect(issues).toEqual([
      {
        row: 3,
        ref: 'KB-1',
        message: 'Duplicate ID KB-1; the first row with it was imported',
        skipped: true,
      },
    ]);
  });

  it('ignores blank rows', () => {
    const { rows, issues } = parseKbTable([
      HEADER,
      ['', ' ', ''],
      [],
      r('A1', 'Existing client', 'q', 'a'),
    ]);
    expect(issues).toEqual([]);
    expect(rows.map((x) => x.row)).toEqual([4]);
  });

  it('emits an optional key only when its column exists', () => {
    const { rows } = parseKbTable([
      ['Ref', 'AUDIENCE', 'question', 'Answer'],
      ['A1', 'Existing client', 'q', 'a'],
    ]);
    // No status key: the RPC keeps the stored status (draft on insert).
    expect(rows[0]).toEqual({
      ref: 'A1',
      audience: 'existing_client',
      question: 'q',
      answer_en: 'a',
      row: 2,
    });
  });

  it('emits a blank optional cell so the RPC clears it', () => {
    const { rows } = parseKbTable([
      [
        'ID',
        'Audience',
        'Question',
        'English answer',
        'Arabic answer',
        'Notes',
      ],
      ['A1', 'Existing client', 'q', 'a', '', ''],
    ]);
    expect(rows[0]).toMatchObject({ answer_ar: '', reviewer_notes: '' });
  });

  it('reads header aliases and the hand-off column', () => {
    const { rows } = parseKbTable([
      [
        'id',
        'audience',
        'Question',
        'Answer (EN)',
        'Bot answer (Arabic)',
        'Reviewer comments',
        'Hand off',
      ],
      ['A1', 'Existing client', 'q', 'a', 'ج', 'n', 'Yes'],
      ['A2', 'Existing client', 'q', 'a', '', '', 'y'],
      ['A3', 'Existing client', 'q', 'a', '', '', 'TRUE'],
      ['A4', 'Existing client', 'q', 'a', '', '', '1'],
      ['A5', 'Existing client', 'q', 'a', '', '', 'no'],
      ['A6', 'Existing client', 'q', 'a', '', '', ''],
    ]);
    expect(rows[0]).toMatchObject({ answer_ar: 'ج', reviewer_notes: 'n' });
    expect(rows.map((x) => x.handoff_after)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    const handoffAfter = parseKbTable([
      ['ID', 'Audience', 'Question', 'Answer', 'Handoff after'],
      ['A1', 'Existing client', 'q', 'a', 'yes'],
    ]);
    expect(handoffAfter.rows[0].handoff_after).toBe(true);
  });

  it('reports a sheet with no header row', () => {
    expect(parseKbTable([['README'], ['Some text']])).toEqual({
      rows: [],
      issues: [
        {
          row: null,
          ref: null,
          message: 'No header row with a Question and an Answer column',
          skipped: false,
        },
      ],
    });
  });

  it('reports a header row with no ID or Audience column', () => {
    expect(
      parseKbTable([
        ['Question', 'Answer'],
        ['q', 'a'],
      ]).issues
    ).toEqual([
      {
        row: 1,
        ref: null,
        message: 'The header row has no ID or Audience column',
        skipped: false,
      },
    ]);
  });
});

describe('pickKbSheet', () => {
  const kb = { name: 'Knowledge_Base', rows: [HEADER] };
  const readme = { name: 'README', rows: [['How to review']] };

  it('picks the sheet named Knowledge_Base, ignoring case, _ and spaces', () => {
    expect(pickKbSheet([readme, kb])).toBe(kb);
    const spaced = { name: 'knowledge base', rows: [] };
    expect(pickKbSheet([readme, spaced])).toBe(spaced);
  });

  it('else picks the first sheet with a question and an answer column', () => {
    const other = {
      name: 'Answers',
      rows: [['title'], ['ID', 'Question', 'Bot answer']],
    };
    expect(pickKbSheet([readme, other])).toBe(other);
  });

  it('returns null when no sheet fits', () => {
    expect(pickKbSheet([readme])).toBeNull();
    expect(pickKbSheet([])).toBeNull();
  });
});
