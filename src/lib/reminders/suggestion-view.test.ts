import { describe, expect, it } from 'vitest';
import { MIN_CUSTOM_LEAD_MS } from '@/lib/tasks/reminder';
import { TASK_NOTE_MAX } from '@/lib/tasks/types';
import type { ReminderSuggestion } from '@/lib/reminders/types';
import {
  chipFor,
  chipWhenLabel,
  mergeLoadedSuggestions,
  reminderNote,
  reminderTitleKey,
  suggestionActionResult,
  withSuggestion,
  withoutSuggestion,
} from './suggestion-view';

const NOW = Date.parse('2026-11-12T10:00:00Z');

function s(over: Partial<ReminderSuggestion> = {}): ReminderSuggestion {
  return {
    id: 's1',
    account_id: 'a1',
    conversation_id: 'c1',
    message_id: 'm1',
    side: 'customer',
    kind: 'call',
    due_at: '2026-11-13T11:00:00Z',
    date_only: false,
    phrase: 'tomorrow at 3',
    p: 0.9,
    status: 'open',
    task_id: null,
    acted_by: null,
    acted_at: null,
    created_at: '2026-11-12T08:00:00Z',
    ...over,
  };
}

describe('chipFor', () => {
  it('is null for none or dismissed', () => {
    expect(chipFor(undefined, NOW)).toBeNull();
    expect(chipFor(s({ status: 'dismissed' }), NOW)).toBeNull();
  });

  it('shows an open one', () => {
    expect(chipFor(s({ date_only: true, kind: 'payment' }), NOW)).toEqual({
      state: 'open',
      dueAt: new Date('2026-11-13T11:00:00Z'),
      dateOnly: true,
      suggestionId: 's1',
      kind: 'payment',
    });
  });

  it('is added only while the task exists', () => {
    expect(chipFor(s({ status: 'added', task_id: 't1' }), NOW)?.state).toBe(
      'added'
    );
    expect(chipFor(s({ status: 'added', task_id: null }), NOW)?.state).toBe(
      'open'
    );
  });

  it('hides an open one due within the minimum lead, but keeps an added one', () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(chipFor(s({ due_at: at(MIN_CUSTOM_LEAD_MS) }), NOW)).toBeNull();
    expect(chipFor(s({ due_at: at(-60_000) }), NOW)).toBeNull();
    expect(chipFor(s({ due_at: at(MIN_CUSTOM_LEAD_MS + 1) }), NOW)?.state).toBe(
      'open'
    );
    expect(
      chipFor(s({ due_at: at(-60_000), status: 'added', task_id: 't1' }), NOW)
        ?.state
    ).toBe('added');
    expect(
      chipFor(s({ due_at: at(-60_000), status: 'added', task_id: null }), NOW)
    ).toBeNull();
  });
});

describe('chipWhenLabel', () => {
  const words = { today: 'Today', tomorrow: 'Tomorrow' };
  const now = new Date(2026, 10, 17, 8, 30); // local Tue 17 Nov 2026

  it('says Today and Tomorrow', () => {
    expect(
      chipWhenLabel(new Date(2026, 10, 17, 15, 0), now, 'en-GB', words)
    ).toBe('Today 15:00');
    expect(
      chipWhenLabel(new Date(2026, 10, 18, 9, 0), now, 'en-GB', words)
    ).toBe('Tomorrow 09:00');
  });

  it('crosses a month end for tomorrow', () => {
    const late = new Date(2026, 10, 30, 22, 0);
    expect(
      chipWhenLabel(new Date(2026, 11, 1, 9, 0), late, 'en-GB', words)
    ).toBe('Tomorrow 09:00');
  });

  it('formats a later day with the locale', () => {
    expect(
      chipWhenLabel(new Date(2026, 10, 19, 10, 0), now, 'en-GB', words)
    ).toBe('Thu 19 Nov, 10:00');
  });
});

describe('reminderTitleKey', () => {
  it('maps every kind', () => {
    expect(reminderTitleKey('call')).toBe('titleCall');
    expect(reminderTitleKey('documents')).toBe('titleDocuments');
    expect(reminderTitleKey('payment')).toBe('titlePayment');
    expect(reminderTitleKey('meeting')).toBe('titleMeeting');
    expect(reminderTitleKey('follow_up')).toBe('titleFollowUp');
  });
});

describe('reminderNote', () => {
  it('quotes the text with whitespace collapsed', () => {
    expect(reminderNote('  call me\n\ttomorrow   at 3 ')).toBe(
      '"call me tomorrow at 3"'
    );
    expect(reminderNote(' \n ')).toBe('');
  });

  it('clips to the task note limit', () => {
    const note = reminderNote('x'.repeat(TASK_NOTE_MAX * 2));
    expect(note).toHaveLength(TASK_NOTE_MAX);
    expect(note.endsWith('…"')).toBe(true);
    const fits = 'y'.repeat(TASK_NOTE_MAX - 2);
    expect(reminderNote(fits)).toBe(`"${fits}"`);
  });
});

describe('withSuggestion / withoutSuggestion', () => {
  it('keys by message and replaces on update, without mutating', () => {
    const a = s();
    const m1 = withSuggestion(new Map(), a);
    const b = s({ status: 'added', task_id: 't1' });
    const m2 = withSuggestion(m1, b);
    expect(m1.get('m1')).toBe(a);
    expect(m2.get('m1')).toBe(b);
    expect(m2.size).toBe(1);
    const m3 = withSuggestion(m2, s({ id: 's2', message_id: 'm2' }));
    expect(m3.size).toBe(2);
  });

  it('removes by suggestion id', () => {
    const m = withSuggestion(
      withSuggestion(new Map(), s()),
      s({ id: 's2', message_id: 'm2' })
    );
    const out = withoutSuggestion(m, 's1');
    expect([...out.keys()]).toEqual(['m2']);
    expect(m.size).toBe(2);
    expect(withoutSuggestion(m, 'nope').size).toBe(2);
  });
});

describe('mergeLoadedSuggestions', () => {
  it('lays rows already in state over the read, keeping both sides', () => {
    const read = s({ id: 's1', message_id: 'm1' });
    const readOther = s({ id: 's2', message_id: 'm2' });
    const newer = s({ id: 's1', message_id: 'm1', status: 'dismissed' });
    const arrived = s({ id: 's3', message_id: 'm3' });
    const loaded = new Map([
      ['m1', read],
      ['m2', readOther],
    ]);
    const current = new Map([
      ['m1', newer],
      ['m3', arrived],
    ]);
    const out = mergeLoadedSuggestions(loaded, current);
    expect(out.get('m1')).toBe(newer);
    expect(out.get('m2')).toBe(readOther);
    expect(out.get('m3')).toBe(arrived);
    expect(out.size).toBe(3);
    expect(loaded.get('m1')).toBe(read);
  });
});

describe('suggestionActionResult', () => {
  it('merges the row of a 200', () => {
    const row = s({ status: 'added', task_id: 't1' });
    expect(suggestionActionResult(200, { suggestion: row })).toEqual({
      outcome: 'ok',
      suggestion: row,
    });
  });

  it('marks a 409 as a conflict and still merges its row', () => {
    const row = s({ status: 'dismissed' });
    expect(
      suggestionActionResult(409, { error: 'conflict', suggestion: row })
    ).toEqual({ outcome: 'conflict', suggestion: row });
  });

  it('fails on any other status, or none, with nothing to merge', () => {
    for (const status of [400, 403, 404, 500, null]) {
      expect(suggestionActionResult(status, { suggestion: s() })).toEqual({
        outcome: 'failed',
        suggestion: null,
      });
    }
  });

  it('merges nothing when the body is not a row', () => {
    expect(suggestionActionResult(200, null).suggestion).toBeNull();
    expect(
      suggestionActionResult(200, { suggestion: { id: 1 } }).suggestion
    ).toBeNull();
    expect(suggestionActionResult(409, { error: 'x' })).toEqual({
      outcome: 'conflict',
      suggestion: null,
    });
  });
});
