import { describe, expect, it } from 'vitest';

import { hrRuleTitle, hrTaskTitle } from './task-title';

describe('hrTaskTitle', () => {
  const task = {
    title: 'Review CV',
    meta: { hr_rule: 'stage_cv_review', hr_title_ar: 'مراجعة السيرة الذاتية' },
  };

  it('shows the Arabic snapshot to an Arabic viewer', () => {
    expect(hrTaskTitle(task, 'ar')).toBe('مراجعة السيرة الذاتية');
  });

  it('shows the English title in any other locale', () => {
    expect(hrTaskTitle(task, 'en')).toBe('Review CV');
    expect(hrTaskTitle(task, 'ko')).toBe('Review CV');
  });

  it('falls back to the title when there is no usable snapshot', () => {
    expect(hrTaskTitle({ title: 'Review CV', meta: {} }, 'ar')).toBe(
      'Review CV'
    );
    expect(hrTaskTitle({ title: 'Review CV' }, 'ar')).toBe('Review CV');
    expect(hrTaskTitle({ title: 'Review CV', meta: null }, 'ar')).toBe(
      'Review CV'
    );
    expect(
      hrTaskTitle({ title: 'Review CV', meta: { hr_title_ar: '  ' } }, 'ar')
    ).toBe('Review CV');
    expect(
      hrTaskTitle({ title: 'Review CV', meta: { hr_title_ar: 7 } }, 'ar')
    ).toBe('Review CV');
  });
});

describe('hrRuleTitle', () => {
  it('picks the Arabic title for ar, else the English one', () => {
    const rule = { title: 'Chase candidate', title_ar: 'متابعة المرشح' };
    expect(hrRuleTitle(rule, 'ar')).toBe('متابعة المرشح');
    expect(hrRuleTitle(rule, 'en')).toBe('Chase candidate');
    expect(
      hrRuleTitle({ title: 'Chase candidate', title_ar: null }, 'ar')
    ).toBe('Chase candidate');
  });
});
