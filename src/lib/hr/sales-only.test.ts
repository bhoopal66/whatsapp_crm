import { describe, expect, it } from 'vitest';

import { showsSalesInsights } from './sales-only';

describe('showsSalesInsights', () => {
  it('is off on every HR inbox screen', () => {
    expect(showsSalesInsights({ hrScreen: true })).toBe(false);
    expect(showsSalesInsights({ hrScreen: true, inboxDepartment: null })).toBe(
      false
    );
  });

  it('is off for an HR chat wherever it is opened', () => {
    expect(showsSalesInsights({ hrScreen: false, inboxDepartment: 'hr' })).toBe(
      false
    );
  });

  it('stays on for the sales inbox and its chats', () => {
    expect(showsSalesInsights({ hrScreen: false })).toBe(true);
    expect(showsSalesInsights({ hrScreen: false, inboxDepartment: null })).toBe(
      true
    );
    expect(
      showsSalesInsights({ hrScreen: false, inboxDepartment: 'sales' })
    ).toBe(true);
  });
});
