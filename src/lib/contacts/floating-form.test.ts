import { describe, expect, it } from 'vitest';

import { keepFloatingFormOpen } from './floating-form';

describe('keepFloatingFormOpen', () => {
  it('ignores an Escape pressed outside a floating form', () => {
    expect(
      keepFloatingFormOpen({
        floating: true,
        reason: 'escape-key',
        insideForm: false,
      })
    ).toBe(true);
  });

  it('closes on an Escape inside it, on the close button, or when modal', () => {
    expect(
      keepFloatingFormOpen({
        floating: true,
        reason: 'escape-key',
        insideForm: true,
      })
    ).toBe(false);
    expect(
      keepFloatingFormOpen({
        floating: true,
        reason: 'close-press',
        insideForm: false,
      })
    ).toBe(false);
    expect(
      keepFloatingFormOpen({
        floating: false,
        reason: 'escape-key',
        insideForm: false,
      })
    ).toBe(false);
  });
});
