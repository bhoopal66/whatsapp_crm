import { describe, expect, it } from 'vitest';

import { parseEntryInput, parseSubjectKey } from './entry-input';

const form = (fields: Record<string, string>) => (name: string) =>
  fields[name] ?? null;

const SUBJECT_ID = '0b9a4a43-3f0d-4a6e-9d2a-2a5e4c1f6b11';

describe('parseSubjectKey', () => {
  it('reads built-in keys and subject ids', () => {
    expect(parseSubjectKey('builtin:welcome')).toEqual({
      builtin: 'welcome',
      subjectId: null,
    });
    expect(parseSubjectKey(SUBJECT_ID)).toEqual({
      builtin: null,
      subjectId: SUBJECT_ID,
    });
    expect(parseSubjectKey('builtin:pricing')).toBeNull();
    expect(parseSubjectKey('nope')).toBeNull();
  });
});

describe('parseEntryInput', () => {
  const common = { subject: 'builtin:welcome', language: 'en', title: 'Hi' };

  it('accepts a recording', () => {
    expect(
      parseEntryInput(
        form({ ...common, source: 'recording', duration_ms: '4200' })
      )
    ).toEqual({
      ok: true,
      value: {
        source: 'recording',
        subject: { builtin: 'welcome', subjectId: null },
        language: 'en',
        title: 'Hi',
        durationMs: 4200,
      },
    });
  });

  it('accepts a personalised script and defaults the voice', () => {
    const r = parseEntryInput(
      form({
        ...common,
        source: 'tts',
        script: ' Hello {name} ',
        personalised: 'true',
        voice: 'robot',
      })
    );
    expect(r).toMatchObject({
      ok: true,
      value: { script: 'Hello {name}', personalised: true, voice: 'coral' },
    });
  });

  it('names the first problem', () => {
    expect(parseEntryInput(form({ ...common, language: 'fr' }))).toEqual({
      ok: false,
      error: 'language',
    });
    expect(parseEntryInput(form({ ...common, title: ' ' }))).toEqual({
      ok: false,
      error: 'title',
    });
    expect(
      parseEntryInput(form({ ...common, source: 'tts', script: 'Hi {name}' }))
    ).toEqual({ ok: false, error: 'placeholder_in_fixed' });
    expect(parseEntryInput(form({ ...common, source: 'upload' }))).toEqual({
      ok: false,
      error: 'source',
    });
  });
});
