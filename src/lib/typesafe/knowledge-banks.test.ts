import { describe, expect, it } from 'vitest';
import { knowledgeBankMentions } from './knowledge-banks';

describe('knowledgeBankMentions', () => {
  it('counts documents, not chunks, most documents first', () => {
    const out = knowledgeBankMentions([
      {
        document_id: 'd1',
        content: 'Salary transfer to First Abu Dhabi Bank.',
      },
      { document_id: 'd1', content: 'FAB also offers personal loans.' },
      { document_id: 'd2', content: 'We work with FAB and Mashreq.' },
      { document_id: 'd3', content: 'Apply through Emirates NBD.' },
      { document_id: 'd3', content: 'Nothing about banks here.' },
    ]);
    expect(out).toEqual([
      { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)', documents: 2 },
      { code: 'ENBD', name: 'Emirates NBD', documents: 1 },
      { code: 'MASHREQ', name: 'Mashreq', documents: 1 },
    ]);
  });

  it('finds Arabic names', () => {
    expect(
      knowledgeBankMentions([
        { document_id: 'd1', content: 'بنك ابوظبي الاول' },
      ])
    ).toEqual([
      { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)', documents: 1 },
    ]);
  });

  it('does not join two chunks into one name', () => {
    expect(
      knowledgeBankMentions([
        { document_id: 'd1', content: 'Our office in first abu' },
        { document_id: 'd1', content: 'dhabi bank street' },
      ])
    ).toEqual([]);
  });

  it('is empty for no chunks or blank content', () => {
    expect(knowledgeBankMentions([])).toEqual([]);
    expect(knowledgeBankMentions([{ document_id: 'd1', content: '' }])).toEqual(
      []
    );
  });
});
