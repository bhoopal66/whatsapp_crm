import { describe, expect, it } from 'vitest';

import {
  mergeWorklistLoad,
  worklistLoadStatus,
  type WorklistPart,
  type WorklistRead,
} from './load-state';

const read = (tag: string, failed: WorklistPart[] = []): WorklistRead => {
  const rows = (part: WorklistPart) =>
    failed.includes(part) ? [] : [{ tag } as never];
  return {
    inputs: {
      hrConversations: rows('hr'),
      hrTasks: rows('hr'),
      hrRules: rows('hr'),
      drafts: rows('drafts'),
      cases: rows('cases'),
    },
    failed,
    casesTruncated: false,
  };
};

describe('mergeWorklistLoad', () => {
  it('holds a clean read as it is', () => {
    const r = read('a');
    const m = mergeWorklistLoad(null, r);
    expect(m).toEqual({
      inputs: r.inputs,
      missing: [],
      stale: [],
      casesTruncated: false,
    });
    expect(worklistLoadStatus(m)).toBe('ok');
  });

  it('a part that was never read is missing, and stays missing', () => {
    let m = mergeWorklistLoad(null, read('a', ['cases']));
    expect(m.missing).toEqual(['cases']);
    expect(worklistLoadStatus(m)).toBe('partial');
    m = mergeWorklistLoad(m, read('b', ['cases']));
    expect([m.missing, m.stale]).toEqual([['cases'], []]);
  });

  it('a part read before keeps its last good rows, the rest is fresh', () => {
    let m = mergeWorklistLoad(null, read('a'));
    m = mergeWorklistLoad(m, read('b', ['hr']));
    const a = [{ tag: 'a' }];
    const b = [{ tag: 'b' }];
    expect(m.inputs).toEqual({
      hrConversations: a,
      hrTasks: a,
      hrRules: a,
      drafts: b,
      cases: b,
    });
    expect([m.missing, m.stale]).toEqual([[], ['hr']]);
    expect(worklistLoadStatus(m)).toBe('stale');
    // Still held after a second failure, and clean once it reads again.
    m = mergeWorklistLoad(m, read('c', ['hr', 'drafts', 'cases']));
    expect(m.inputs.hrTasks).toEqual(a);
    expect(worklistLoadStatus(m)).toBe('stale');
    m = mergeWorklistLoad(m, read('d'));
    expect(m).toEqual({
      inputs: read('d').inputs,
      missing: [],
      stale: [],
      casesTruncated: false,
    });
  });

  it('a cut case list is cut for as long as its rows are the ones held', () => {
    let m = mergeWorklistLoad(null, { ...read('a'), casesTruncated: true });
    expect(m.casesTruncated).toBe(true);
    m = mergeWorklistLoad(m, read('b', ['cases']));
    expect(m.casesTruncated).toBe(true);
    m = mergeWorklistLoad(m, read('c'));
    expect(m.casesTruncated).toBe(false);
  });

  it('can hold a missing and a stale part at once', () => {
    let m = mergeWorklistLoad(null, read('a', ['drafts']));
    m = mergeWorklistLoad(m, read('b', ['drafts', 'cases']));
    expect([m.missing, m.stale]).toEqual([['drafts'], ['cases']]);
    expect(worklistLoadStatus(m)).toBe('partial');
  });

  it('is failed only when no part was ever read', () => {
    const m = mergeWorklistLoad(null, read('a', ['hr', 'drafts', 'cases']));
    expect(worklistLoadStatus(m)).toBe('failed');
    expect(worklistLoadStatus(mergeWorklistLoad(m, read('b')))).toBe('ok');
  });
});
