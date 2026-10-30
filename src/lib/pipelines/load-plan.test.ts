import { describe, expect, it } from 'vitest';
import {
  canUseSpeculativeDeals,
  dealsQuestion,
  pipelinesCacheKey,
  planFirstWave,
  stagesCacheKey,
} from './load-plan';
import { sessionKey } from '@/lib/session-cache';

describe('cache keys', () => {
  it('name the account and the pipeline', () => {
    expect(pipelinesCacheKey('a1')).toBe('pipelines:a1');
    expect(pipelinesCacheKey('a1')).not.toBe(pipelinesCacheKey('a2'));
    expect(stagesCacheKey('p1')).not.toBe(stagesCacheKey('p2'));
  });

  it('keeps deals apart per pipeline and per owner filter', () => {
    const all = dealsQuestion('p1', null);
    expect(all).not.toBe(dealsQuestion('p2', null));
    expect(all).not.toBe(dealsQuestion('p1', 'user_id.eq.u1'));
  });

  it('builds a session key only with account and user', () => {
    const q = dealsQuestion('p1', null);
    expect(sessionKey('a1', 'u1', q)).not.toBe(sessionKey('a1', 'u2', q));
    expect(sessionKey(null, 'u1', q)).toBeNull();
  });
});

describe('planFirstWave', () => {
  it('starts the remembered pipeline deals in the first wave', () => {
    expect(planFirstWave('p1', null)).toEqual({ dealsFor: 'p1' });
  });
  it('starts nothing without a guess or under an owner filter', () => {
    expect(planFirstWave(null, null).dealsFor).toBeNull();
    expect(planFirstWave('p1', 'user_id.eq.u1').dealsFor).toBeNull();
  });
});

describe('canUseSpeculativeDeals', () => {
  it('accepts a right guess', () => {
    expect(canUseSpeculativeDeals({ id: 'p1' }, 'p1', null)).toBe(true);
  });
  it('rejects a wrong guess, a filter, or nothing started', () => {
    expect(canUseSpeculativeDeals({ id: 'p1' }, 'p2', null)).toBe(false);
    expect(canUseSpeculativeDeals({ id: 'p1' }, 'p1', 'x')).toBe(false);
    expect(canUseSpeculativeDeals(null, 'p1', null)).toBe(false);
  });
});
