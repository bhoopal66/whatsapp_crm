import { describe, expect, it } from 'vitest';
import { noul } from '@typesafe-ai/sdk';
import { GATEWAY_CHECKS, SELECTION_CALLERS } from './client';
import { CHECK_NAMES } from './config';
import {
  makeLayer,
  makeSim,
  TEST_ACCOUNT,
  type SimReply,
} from './test-helpers';

const QUESTIONS = { q: noul('Is `text` a greeting?') } as const;

describe('selection callers', () => {
  it('are gateway checks alongside the safety checks, never one of them', () => {
    for (const c of SELECTION_CALLERS) {
      expect(GATEWAY_CHECKS).toContain(c);
      expect(CHECK_NAMES as readonly string[]).not.toContain(c);
    }
    expect(new Set(GATEWAY_CHECKS).size).toBe(GATEWAY_CHECKS.length);
  });

  it.each(SELECTION_CALLERS.filter((c) => c !== 'route'))(
    'each has its own breaker: a %s outage pauses neither route nor triage',
    async (caller) => {
      const sim = makeSim((): SimReply => ({ status: 503 }));
      const { layer } = makeLayer({ sim });
      for (let i = 0; i < 5; i++)
        await layer.gateway.ask(
          caller,
          { text: 'hi' },
          QUESTIONS,
          TEST_ACCOUNT
        );
      expect(layer.gateway.available(caller)).toBe(false);
      expect(layer.gateway.available('route')).toBe(true);
      expect(layer.gateway.available('triage')).toBe(true);
      for (const other of SELECTION_CALLERS)
        if (other !== caller) expect(layer.gateway.available(other)).toBe(true);
    }
  );
});
