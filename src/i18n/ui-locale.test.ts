import { afterEach, describe, expect, it, vi } from 'vitest';

import { dateFnsLocale, uiLocale } from './ui-locale';

afterEach(() => vi.unstubAllGlobals());
const page = (lang: string) =>
  vi.stubGlobal('document', { documentElement: { lang } });

describe('uiLocale', () => {
  it('is what the page says, when that is a language of ours', () => {
    page('ar');
    expect(uiLocale()).toBe('ar');
    page('fr');
    expect(uiLocale()).toBeUndefined();
  });

  it('is unknown on the server', () => {
    expect(uiLocale()).toBeUndefined();
  });
});

describe('dateFnsLocale', () => {
  it('follows the page, else English', () => {
    expect(dateFnsLocale('ar').code).toBe('ar');
    expect(dateFnsLocale('ko').code).toBe('ko');
    expect(dateFnsLocale('xx').code).toBe('en-US');
    page('ko');
    expect(dateFnsLocale().code).toBe('ko');
  });
});
