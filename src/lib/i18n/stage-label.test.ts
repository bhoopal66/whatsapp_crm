import fs from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGES } from '@/lib/cases/ui';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

import { BUILT_IN_STAGE_KEYS, stageLabel } from './stage-label';

const CATALOGUES = { en, ar, ko } as const;

function translator(locale: keyof typeof CATALOGUES) {
  const t = createTranslator({
    locale,
    messages: CATALOGUES[locale],
    namespace: 'StageNames',
  });
  return (key: string) => t(key as never);
}

const PIPELINES_PAGE = path.resolve(
  __dirname,
  '../../app/(dashboard)/pipelines/page.tsx'
);

/** The names in the pipelines page's SPEC_DEFAULT_STAGES seed. */
function seededPipelineStages(): string[] {
  const src = fs.readFileSync(PIPELINES_PAGE, 'utf8');
  const block = /const SPEC_DEFAULT_STAGES = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error('SPEC_DEFAULT_STAGES not found');
  return [...block[1].matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
}

describe('stageLabel', () => {
  it('shows a built-in name in Arabic and Korean', () => {
    expect(stageLabel('Submitted', translator('ar'))).toBe('تم التقديم');
    expect(stageLabel('Submitted', translator('ko'))).toBe('제출됨');
    expect(stageLabel('New Lead', translator('ar'))).toBe('عميل محتمل جديد');
    expect(stageLabel('New Lead', translator('ko'))).toBe('신규 리드');
  });

  it('shows every built-in name unchanged in English', () => {
    const t = translator('en');
    for (const name of Object.keys(BUILT_IN_STAGE_KEYS)) {
      expect(stageLabel(name, t)).toBe(name);
    }
  });

  it('translates every built-in name in ar and ko', () => {
    for (const locale of ['ar', 'ko'] as const) {
      const t = translator(locale);
      for (const name of Object.keys(BUILT_IN_STAGE_KEYS)) {
        const shown = stageLabel(name, t);
        expect(shown).not.toBe(name);
        expect(shown).not.toContain('StageNames');
      }
    }
  });

  it('keeps a renamed or typed name exactly as typed', () => {
    const t = translator('ar');
    expect(stageLabel('Site visit booked', t)).toBe('Site visit booked');
    // Case-sensitive: a team's "submitted" is their own name.
    expect(stageLabel('submitted', t)).toBe('submitted');
    expect(stageLabel('New lead', t)).toBe('New lead');
    expect(stageLabel('Won (Q4)', t)).toBe('Won (Q4)');
  });

  it('ignores blanks at either end of a built-in name', () => {
    expect(stageLabel('  Approved ', translator('ko'))).toBe('승인됨');
    expect(stageLabel('Proposal Sent\n', translator('ar'))).toBe(
      'تم إرسال العرض'
    );
    // Inner spacing is part of the name.
    expect(stageLabel('Proposal  Sent', translator('ar'))).toBe(
      'Proposal  Sent'
    );
  });

  it('passes empty and missing names through', () => {
    const t = translator('ar');
    expect(stageLabel('', t)).toBe('');
    expect(stageLabel(null, t)).toBeNull();
    expect(stageLabel(undefined, t)).toBeUndefined();
    expect(stageLabel('   ', t)).toBe('   ');
    expect(stageLabel('constructor', t)).toBe('constructor');
  });

  it('knows every seeded stage, and each en string equals the stored name', () => {
    const seeded = [...seededPipelineStages(), ...DEFAULT_STAGES];
    expect(seeded.length).toBeGreaterThan(DEFAULT_STAGES.length);
    expect(Object.keys(BUILT_IN_STAGE_KEYS).sort()).toEqual([...seeded].sort());
    const names = en.StageNames as Record<string, string>;
    for (const [name, key] of Object.entries(BUILT_IN_STAGE_KEYS)) {
      expect(names[key]).toBe(name);
    }
  });
});
