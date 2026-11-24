import { describe, expect, it } from 'vitest';

import {
  INTAKE_KINDS,
  INTAKE_PLACEHOLDERS,
  caseFilesErrorKey,
  parseIntakeTemplates,
  templateBodyProblem,
} from './settings-view';

describe('intake wording helpers', () => {
  it('always returns the three kinds, tolerating junk', () => {
    const junk = [null, 'x', {}, { templates: 5 }, { templates: [null, 3] }];
    for (const payload of junk) {
      const out = parseIntakeTemplates(payload);
      expect(out.map((t) => t.kind)).toEqual([...INTAKE_KINDS]);
      expect(out.every((t) => t.body === null && !t.approved)).toBe(true);
    }
  });

  it('reads body and approval, never approved without a body', () => {
    const out = parseIntakeTemplates({
      templates: [
        {
          kind: 'document_rejected',
          body: 'Hi {doc}',
          approved: true,
          updatedAt: '2026-11-24T10:00:00.123456+00:00',
        },
        { kind: 'document_classify', body: null, approved: true },
        { kind: 'other', body: 'x', approved: true },
      ],
    });
    expect(out[0]).toEqual({
      kind: 'document_classify',
      body: null,
      approved: false,
      updatedAt: null,
    });
    expect(out[1]).toEqual({
      kind: 'document_rejected',
      body: 'Hi {doc}',
      approved: true,
      updatedAt: '2026-11-24T10:00:00.123456+00:00',
    });
    expect(out[2].body).toBeNull();
  });

  it('flags blank and over-long wording', () => {
    expect(templateBodyProblem('')).toBe('blank');
    expect(templateBodyProblem(' \n\t')).toBe('blank');
    expect(templateBodyProblem('a'.repeat(1000))).toBeNull();
    expect(templateBodyProblem('a'.repeat(1001))).toBe('tooLong');
  });

  it('lists the placeholders per kind', () => {
    expect(INTAKE_PLACEHOLDERS.document_classify).toEqual(['{file}', '{list}']);
    expect(INTAKE_PLACEHOLDERS.document_rejected).toEqual([
      '{doc}',
      '{checks}',
    ]);
    expect(INTAKE_PLACEHOLDERS.document_received_next).toEqual([
      '{doc}',
      '{list}',
    ]);
  });

  it('maps the new refusal codes', () => {
    expect(caseFilesErrorKey({ code: 'SELF_APPROVAL' }, 409)).toBe(
      'selfApproval'
    );
    expect(caseFilesErrorKey({ code: 'TEMPLATE_INVALID' }, 422)).toBe(
      'templateInvalid'
    );
  });
});
