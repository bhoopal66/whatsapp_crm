import { describe, expect, it } from 'vitest';

import {
  COMPASS_TEMPLATES,
  compassTemplateFor,
  compassTemplateProblem,
  SERVICE_WINDOW_MS,
  serviceWindowOpen,
} from './meta-template';
import { APPROVED_TEXT, SUBMITTED_TEXT } from './compass-messages.fixture';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';

describe('serviceWindowOpen', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  it('is closed with no customer message', () => {
    expect(serviceWindowOpen(null, now)).toBe(false);
    expect(serviceWindowOpen('not a date', now)).toBe(false);
  });
  it('is open shortly after the customer wrote', () => {
    expect(serviceWindowOpen('2026-11-18T08:00:00Z', now)).toBe(true);
  });
  it('closes ten minutes before Meta’s 24 hours', () => {
    expect(SERVICE_WINDOW_MS).toBe(24 * 3600_000 - 600_000);
    expect(
      serviceWindowOpen(
        new Date(now - SERVICE_WINDOW_MS + 1000).toISOString(),
        now
      )
    ).toBe(true);
    expect(
      serviceWindowOpen(new Date(now - SERVICE_WINDOW_MS).toISOString(), now)
    ).toBe(false);
  });
});

describe('compassTemplateFor', () => {
  it('reads company and bank out of a submitted message', () => {
    const hit = compassTemplateFor('case.submitted', SUBMITTED_TEXT);
    expect(hit?.template.name).toBe('compass_case_submitted');
    expect(hit?.params).toEqual([
      'BLUE PALM TRADING L.L.C',
      'MASHREQ',
    ]);
  });

  it('reads company and bank out of an approved message', () => {
    const hit = compassTemplateFor('case.approved', APPROVED_TEXT);
    expect(hit?.template.name).toBe('compass_case_approved');
    expect(hit?.params).toEqual([
      'SILVER DUNE FURNITURE & DECOR IND. FACTORY LLC.',
      'NBF',
    ]);
  });

  it('renders back to exactly what Compass sent', () => {
    for (const [event, text] of [
      ['case.submitted', SUBMITTED_TEXT],
      ['case.approved', APPROVED_TEXT],
    ]) {
      const hit = compassTemplateFor(event, text)!;
      // The renderer the send path stores the message with (and that
      // mirrors what Meta delivers).
      expect(renderTemplateBody(hit.template.body, hit.params)).toBe(text);
    }
  });

  it('tolerates CRLF line endings and trailing spaces', () => {
    const crlf = SUBMITTED_TEXT.replace(/\n/g, '  \r\n');
    expect(compassTemplateFor('case.submitted', crlf)?.params).toEqual([
      'BLUE PALM TRADING L.L.C',
      'MASHREQ',
    ]);
  });

  it('keeps a company name with a comma in it whole', () => {
    const text = SUBMITTED_TEXT.replace(
      'BLUE PALM TRADING L.L.C',
      'ACME, TRADING LLC'
    );
    expect(compassTemplateFor('case.submitted', text)?.params[0]).toBe(
      'ACME, TRADING LLC'
    );
  });

  it('matches only the whole message, nothing added before or after', () => {
    expect(
      compassTemplateFor(
        'case.submitted',
        SUBMITTED_TEXT + '\n\nYour reference: X'
      )
    ).toBeNull();
    expect(
      compassTemplateFor('case.submitted', 'Reference X\n\n' + SUBMITTED_TEXT)
    ).toBeNull();
  });

  it('finds the template from the text when no event is given', () => {
    expect(compassTemplateFor(null, APPROVED_TEXT)?.template.event).toBe(
      'case.approved'
    );
  });

  it('matches nothing when the wording differs or the event disagrees', () => {
    expect(
      compassTemplateFor(
        'case.submitted',
        SUBMITTED_TEXT.replace('keep you informed', 'keep you posted')
      )
    ).toBeNull();
    expect(compassTemplateFor('case.submitted', APPROVED_TEXT)).toBeNull();
    // An event with no template of its own never borrows another's.
    expect(compassTemplateFor('case.rejected', APPROVED_TEXT)).toBeNull();
    expect(
      compassTemplateFor('case.rejected', 'Your application was declined.')
    ).toBeNull();
    expect(compassTemplateFor('case.approved', null)).toBeNull();
  });
});

describe('compassTemplateProblem', () => {
  const t = COMPASS_TEMPLATES[0];
  it('accepts the approved row with the same body', () => {
    expect(
      compassTemplateProblem(t, { status: 'APPROVED', body_text: t.body })
    ).toBeNull();
  });
  it('names what is wrong otherwise', () => {
    expect(compassTemplateProblem(t, null)).toBe('missing');
    expect(
      compassTemplateProblem(t, { status: 'PENDING', body_text: t.body })
    ).toBe('not_approved');
    expect(
      compassTemplateProblem(t, {
        status: 'APPROVED',
        body_text: t.body.replace('Dear', 'Hello'),
      })
    ).toBe('changed');
  });
});
