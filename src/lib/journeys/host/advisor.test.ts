import { describe, expect, it } from 'vitest';
import { step } from '../engine';
import { SHIPPED_WORKFLOW as def } from '../workflow';
import { advisorDecisionsFor } from './advisor';

describe('advisorDecisionsFor', () => {
  it("lists the shipped workflow's decisions per state", () => {
    expect(advisorDecisionsFor(def, 'PRESCREEN')).toEqual([
      'CLOSE',
      'FIT',
      'NO_FIT',
    ]);
    expect(advisorDecisionsFor(def, 'S_MENU')).toEqual(['CLOSE']);
    expect(advisorDecisionsFor(def, 'WON')).toEqual([]);
    expect(advisorDecisionsFor(def, 'NEW')).toEqual([]);
    expect(advisorDecisionsFor(def, 'NOPE')).toEqual([]);
  });

  it('agrees with the engine: a listed decision is handled, an unlisted one warns', () => {
    for (const [state, sd] of Object.entries(def.states)) {
      if (sd.terminal) continue;
      const listed = advisorDecisionsFor(def, state);
      for (const decision of [
        'FIT',
        'QUOTE_READY',
        'DOCS_COMPLETE',
        'PARTNER_APPROVED',
        'FULFILMENT_SCHEDULED',
      ] as const) {
        const file = {
          id: 'f',
          contactId: 'c',
          workspaceId: 'a',
          product: 'POS' as const,
          entry: 'INBOUND' as const,
          state,
          prevOpenState: null,
          window: { lastInboundAt: null, freeEntryUntil: null },
          counters: {
            reengageSent: 0,
            remindersThisStage: 0,
            paidSends: 0,
            paidAfterParked: 0,
          },
          timers: [],
          validUntil: {},
          outcome: null,
          optedOut: false,
          history: [],
          version: 1,
        };
        const r = step(
          def,
          file,
          { type: 'ADVISOR', decision, at: '2026-10-12T08:00:00Z', by: 'u' },
          '2026-10-12T08:00:00Z',
          {
            consent: { marketingOptIn: true, optedOut: false },
            contactHasReceivedOptinWelcome: true,
          }
        );
        const unhandled = r.warnings.some(
          (w) => w.code === 'UNHANDLED_ADVISOR'
        );
        expect(unhandled, `${state} ${decision}`).toBe(
          !listed.includes(decision)
        );
      }
    }
  });
});
