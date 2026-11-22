import { describe, expect, it } from 'vitest';

import {
  cleanSubjectLabel,
  cleanTitle,
  fillScript,
  scriptPlaceholders,
  scriptProblem,
  speakableValue,
} from './script';

describe('scriptProblem', () => {
  it('refuses blank and over-long scripts', () => {
    expect(scriptProblem('  ', false)).toBe('empty');
    expect(scriptProblem('a'.repeat(1501), false)).toBe('too_long');
  });

  it('keeps placeholders out of fixed scripts', () => {
    expect(scriptProblem('Hello {name}', false)).toBe('placeholder_in_fixed');
    expect(scriptProblem('Hello there', false)).toBeNull();
  });

  it('needs a known placeholder in a personalised script', () => {
    expect(scriptProblem('Hello there', true)).toBe('no_placeholder');
    expect(scriptProblem('Hello {first}', true)).toBe('unknown_placeholder');
    expect(scriptProblem('Hello { Name } from {company}', true)).toBeNull();
  });
});

describe('scriptPlaceholders', () => {
  it('lists names once, lower-cased', () => {
    expect(scriptPlaceholders('{Name} {company} {name}')).toEqual([
      'name',
      'company',
    ]);
  });
});

describe('fillScript', () => {
  it('fills name and company', () => {
    expect(
      fillScript(
        'Hello {name}, your file for {company} is ready.',
        { name: 'Aisha', company: 'Acme LLC' },
        'en'
      )
    ).toBe('Hello Aisha, your file for Acme LLC is ready.');
  });

  it('leaves a missing name out and tidies the gap', () => {
    expect(fillScript('Hello {name}, welcome.', { name: null }, 'en')).toBe(
      'Hello, welcome.'
    );
    expect(fillScript('{name}, welcome.', { name: '' }, 'en')).toBe('welcome.');
  });

  it('says "your company" in the entry language when none is known', () => {
    expect(fillScript('Documents for {company}.', {}, 'en')).toBe(
      'Documents for your company.'
    );
    expect(fillScript('مستندات {company}', {}, 'ar')).toBe('مستندات شركتكم');
  });

  it('never speaks a phone number saved as the name', () => {
    expect(fillScript('Hi {name}!', { name: '+971 50 123 4567' }, 'en')).toBe(
      'Hi!'
    );
  });

  it('removes unknown placeholders rather than speaking braces', () => {
    expect(fillScript('Hi {foo} there', {}, 'en')).toBe('Hi there');
  });
});

describe('speakableValue', () => {
  it('strips control characters and markup, caps the length', () => {
    expect(speakableValue('  Ai\u0000sha <b> ')).toBe('Ai sha b');
    expect(speakableValue('x'.repeat(100))?.length).toBe(60);
    expect(speakableValue('1234')).toBeNull();
  });
});

describe('labels', () => {
  it('trims and bounds', () => {
    expect(cleanTitle('  My   note ')).toBe('My note');
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('x'.repeat(81))).toBeNull();
    expect(cleanSubjectLabel('x'.repeat(61))).toBeNull();
    expect(cleanSubjectLabel(5)).toBeNull();
  });
});
