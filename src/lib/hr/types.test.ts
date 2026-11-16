import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  HR_FLAGS,
  HR_INBOXES,
  HR_OUTCOMES,
  HR_RULE_KEYS,
  HR_STAGES,
  HR_TOPIC_FILTERS,
  HR_TOPIC_GROUPS,
  HR_TOPICS,
} from './types';

// Skipped until migration 200 is on the branch (it is written in
// parallel); once it is, every list below is pinned to its text.
const MIGRATION = 'supabase/migrations/200_hr_workflows.sql';
const PATH = join(process.cwd(), MIGRATION);
// The topic list was widened from six to eleven by 201.
const TOPICS_MIGRATION = 'supabase/migrations/201_hr_topics.sql';
const TOPICS_PATH = join(process.cwd(), TOPICS_MIGRATION);

/** `'a', 'b', 'c'` with any whitespace between the items. */
function quotedList(items: readonly string[]): RegExp {
  return new RegExp(items.map((s) => `'${s}'`).join('\\s*,\\s*'));
}

describe('the lists', () => {
  it('have the sizes the spec fixes', () => {
    expect(HR_STAGES).toHaveLength(4);
    expect(HR_TOPICS).toHaveLength(11);
    expect(HR_OUTCOMES).toHaveLength(3);
    expect(HR_FLAGS).toHaveLength(2);
    expect(HR_INBOXES).toHaveLength(2);
    expect(HR_RULE_KEYS).toHaveLength(11);
    expect(new Set(HR_RULE_KEYS).size).toBe(11);
  });
});

describe.skipIf(!existsSync(PATH))(`lists match ${MIGRATION}`, () => {
  const sql = existsSync(PATH) ? readFileSync(PATH, 'utf8') : '';

  it('lists the 4 stages in order', () => {
    expect(sql).toMatch(quotedList(HR_STAGES));
  });

  it.each([
    ['outcomes', HR_OUTCOMES],
    ['flags', HR_FLAGS],
    ['inboxes', HR_INBOXES],
  ] as const)('lists the %s', (_name, list) => {
    expect(sql).toMatch(quotedList(list));
  });

  it.each(HR_RULE_KEYS)('seeds the rule %s', (key) => {
    expect(sql).toContain(`'${key}'`);
  });
});

describe(`topics match ${TOPICS_MIGRATION}`, () => {
  const sql = readFileSync(TOPICS_PATH, 'utf8');

  it('lists the 11 topics in order, in the CHECK and in hr_set_topic', () => {
    const re = quotedList(HR_TOPICS);
    expect(sql.match(new RegExp(re.source, 'g'))).toHaveLength(2);
  });
});

describe('topic groups and filter chips', () => {
  it('group every topic exactly once', () => {
    const all = Object.values(HR_TOPIC_GROUPS).flat();
    expect([...all].sort()).toEqual([...HR_TOPICS].sort());
  });

  it('list only real topics in the chips', () => {
    for (const topics of Object.values(HR_TOPIC_FILTERS)) {
      expect(topics.length).toBeGreaterThan(0);
      for (const t of topics) expect(HR_TOPICS).toContain(t);
    }
  });
});
