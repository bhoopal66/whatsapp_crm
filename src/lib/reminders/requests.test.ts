import { describe, expect, it } from 'vitest';
import { parseReminderSuggestionAction } from './requests';

const TASK = '11111111-2222-4333-8444-555555555555';

describe('parseReminderSuggestionAction', () => {
  it('accepts the three actions', () => {
    expect(
      parseReminderSuggestionAction({ action: 'added', taskId: TASK })
    ).toEqual({ ok: true, value: { action: 'added', taskId: TASK } });
    expect(parseReminderSuggestionAction({ action: 'dismissed' })).toEqual({
      ok: true,
      value: { action: 'dismissed' },
    });
    expect(parseReminderSuggestionAction({ action: 'reopen' })).toEqual({
      ok: true,
      value: { action: 'reopen' },
    });
  });

  it('drops keys an action does not take', () => {
    expect(
      parseReminderSuggestionAction({ action: 'dismissed', taskId: TASK })
    ).toEqual({ ok: true, value: { action: 'dismissed' } });
  });

  it('refuses added without a uuid task id', () => {
    for (const taskId of [undefined, null, '', 'task-1', 42]) {
      expect(
        parseReminderSuggestionAction({ action: 'added', taskId }).ok
      ).toBe(false);
    }
  });

  it('refuses anything else', () => {
    for (const body of [
      null,
      undefined,
      'dismissed',
      [],
      {},
      { action: 'open' },
      { action: 'ADDED', taskId: TASK },
    ]) {
      const r = parseReminderSuggestionAction(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeTruthy();
    }
  });
});
