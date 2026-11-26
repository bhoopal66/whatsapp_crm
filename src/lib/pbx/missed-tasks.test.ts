import { describe, expect, it } from 'vitest';

import { missedBadge } from './missed-tasks';

describe('missedBadge', () => {
  it('names the holder of an open task and who did a done one', () => {
    expect(missedBadge({ status: 'open', name: 'Sara' })).toEqual({
      key: 'taskOpenBy',
      name: 'Sara',
    });
    expect(missedBadge({ status: 'done', name: 'Sara' }).key).toBe(
      'taskDoneBy'
    );
  });

  it('names nobody it does not know', () => {
    expect(missedBadge({ status: 'open', name: null }).key).toBe('taskOpen');
    expect(missedBadge({ status: 'cancelled', name: null }).key).toBe(
      'taskDone'
    );
  });
});
