import { describe, expect, it } from 'vitest';

import { roomTemplateOptions, type RoomTemplateRow } from './room-templates';

const row = (
  id: string,
  name: string,
  over: Partial<RoomTemplateRow> = {}
): RoomTemplateRow => ({
  id,
  name,
  language: 'en',
  body_text: 'Hi',
  status: 'APPROVED',
  ...over,
});

describe('roomTemplateOptions', () => {
  it('offers what Meta approved, and shows the rest with the reason', () => {
    const options = roomTemplateOptions([
      row('local', 'a_local'),
      row('refused', 'b_refused', { submission_error: 'Bad header' }),
      row('wait', 'c_wait', { status: 'PENDING', meta_template_id: '1' }),
      row('draft', 'd_draft', { status: 'DRAFT' }),
      row('ok', 'e_ok', { meta_template_id: '2' }),
    ]);
    expect(options.map((o) => [o.template.id, o.reason])).toEqual([
      ['ok', null],
      ['local', 'not_linked'],
      ['refused', 'not_approved'],
      ['wait', 'waiting'],
    ]);
  });

  it("lists a name and language once: Meta's own row", () => {
    const options = roomTemplateOptions([
      row('copy', 'a', { created_at: '2026-11-20T00:00:00Z' }),
      row('meta', 'a', { meta_template_id: '2' }),
      row('ar', 'a', { language: 'ar', meta_template_id: '3' }),
    ]);
    expect(options.map((o) => o.template.id)).toEqual(['meta', 'ar']);
  });
});
