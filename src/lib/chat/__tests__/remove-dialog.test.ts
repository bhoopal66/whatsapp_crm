import { describe, expect, it } from 'vitest';

import { removeDialogStep, type RemoveDialogState } from '../moderation';

const typed: RemoveDialogState = { reason: 'Spam link', busy: false };

describe('removeDialogStep', () => {
  it('keeps the dialog open with the reason when the removal is refused', () => {
    const sent = removeDialogStep(typed, { type: 'submit' });
    expect(sent).toEqual({ reason: 'Spam link', busy: true, close: false });
    expect(removeDialogStep(sent, { type: 'settled', ok: false })).toEqual({
      reason: 'Spam link',
      busy: false,
      close: false,
    });
  });
  it('closes and forgets the reason only once the removal succeeded', () => {
    const sent = removeDialogStep(typed, { type: 'submit' });
    expect(removeDialogStep(sent, { type: 'settled', ok: true })).toEqual({
      reason: '',
      busy: false,
      close: true,
    });
  });
  it('ignores dismissal and typing while a removal is in flight', () => {
    const busy = { reason: 'Spam link', busy: true };
    expect(removeDialogStep(busy, { type: 'dismiss' }).close).toBe(false);
    expect(removeDialogStep(busy, { type: 'edit', reason: 'x' }).reason).toBe(
      'Spam link'
    );
    expect(removeDialogStep(busy, { type: 'submit' }).busy).toBe(true);
  });
  it('dismissing when idle closes and resets; an invalid reason is not sent', () => {
    expect(removeDialogStep(typed, { type: 'dismiss' })).toEqual({
      reason: '',
      busy: false,
      close: true,
    });
    expect(
      removeDialogStep({ reason: 'no', busy: false }, { type: 'submit' }).busy
    ).toBe(false);
  });
});
