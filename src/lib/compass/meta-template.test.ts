import { describe, expect, it } from 'vitest';

import {
  compassTemplateParam,
  compassTemplateProblem,
  SERVICE_WINDOW_MS,
  serviceWindowOpen,
  type CompassTemplateFields,
} from './meta-template';

const ok: CompassTemplateFields = {
  status: 'APPROVED',
  category: 'Utility',
  body_text: 'Taamul Credit update: {{1}}',
};

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
    expect(serviceWindowOpen('2026-11-17T11:55:00Z', now)).toBe(false);
  });
});

describe('compassTemplateProblem', () => {
  it('accepts an approved utility template with one body variable', () => {
    expect(compassTemplateProblem(ok)).toBeNull();
    expect(
      compassTemplateProblem({ ...ok, body_text: 'Update: {{update}}' })
    ).toBeNull();
    expect(
      compassTemplateProblem({
        ...ok,
        header_type: 'text',
        header_content: 'Taamul Credit',
        buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
      })
    ).toBeNull();
  });
  it('refuses a template Meta has not approved', () => {
    expect(compassTemplateProblem({ ...ok, status: 'PENDING' })).toBe(
      'not_approved'
    );
    expect(compassTemplateProblem({ ...ok, status: undefined })).toBe(
      'not_approved'
    );
  });
  it('refuses a marketing template', () => {
    expect(compassTemplateProblem({ ...ok, category: 'Marketing' })).toBe(
      'not_utility'
    );
  });
  it('needs exactly one body variable', () => {
    expect(compassTemplateProblem({ ...ok, body_text: 'No variable' })).toBe(
      'one_variable'
    );
    expect(
      compassTemplateProblem({ ...ok, body_text: 'Dear {{1}}, {{2}}' })
    ).toBe('one_variable');
  });
  it('refuses anything else that needs a value at send time', () => {
    expect(compassTemplateProblem({ ...ok, header_type: 'image' })).toBe(
      'header'
    );
    expect(
      compassTemplateProblem({
        ...ok,
        header_type: 'text',
        header_content: 'Hi {{1}}',
      })
    ).toBe('header');
    expect(
      compassTemplateProblem({
        ...ok,
        buttons: [{ type: 'URL', text: 'Open', url: 'https://x.test/{{1}}' }],
      })
    ).toBe('buttons');
    expect(
      compassTemplateProblem({
        ...ok,
        buttons: [{ type: 'COPY_CODE', text: 'Copy', example: 'A1' }],
      })
    ).toBe('buttons');
  });
});

describe('compassTemplateParam', () => {
  it('puts the text on one line with no runs of spaces', () => {
    expect(
      compassTemplateParam(
        'Dear ACME LLC,\r\n\r\nThank you for choosing Taamul.\n\tWe are     pleased.  '
      )
    ).toBe('Dear ACME LLC, Thank you for choosing Taamul. We are pleased.');
  });
});
