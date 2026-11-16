import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HR_ERROR_CODES } from '@/lib/hr/types';

import {
  agentKindKey,
  canRunAgents,
  decideErrorKey,
  draftActions,
  draftStatusKey,
  handoffKey,
  intentKey,
  mayActOnDrafts,
  parseSlots,
  RUN_ERRORS,
  runMessage,
} from './panel';
import { AGENT_KINDS, DRAFT_STATUSES, HANDOFF_REASONS, INTENTS } from './types';

const en = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
) as { Hr: Record<string, unknown> };

/** A dotted key under `Hr` resolves to a non-empty string. */
function hasKey(key: string): boolean {
  let node: unknown = en.Hr;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.length > 0;
}

const pending = {
  status: 'pending' as const,
  body: 'Hi',
  requires_template: false,
};

describe('draftActions', () => {
  it('offers approve and reject on a pending draft with a body', () => {
    expect(draftActions(pending, true)).toEqual({
      approve: true,
      reject: true,
      dismiss: false,
      copy: false,
    });
  });

  it('hides approve for a blank body and offers dismiss instead', () => {
    const a = draftActions({ ...pending, body: '  \n' }, true);
    expect(a.approve).toBe(false);
    expect(a.reject).toBe(false);
    expect(a.dismiss).toBe(true);
  });

  it('hides approve when a template is required', () => {
    const a = draftActions({ ...pending, requires_template: true }, true);
    expect(a.approve).toBe(false);
    expect(a.reject).toBe(true);
  });

  it('offers dismiss only on a blank pending draft', () => {
    for (const status of DRAFT_STATUSES) {
      if (status === 'pending') continue;
      expect(draftActions({ ...pending, status, body: '' }, true).dismiss).toBe(
        false
      );
    }
  });

  it('offers copy only on an approved draft', () => {
    for (const status of DRAFT_STATUSES) {
      expect(draftActions({ ...pending, status }, true).copy).toBe(
        status === 'approved'
      );
    }
  });

  it('offers nothing to someone who may not act', () => {
    for (const status of DRAFT_STATUSES) {
      expect(
        Object.values(draftActions({ ...pending, status }, false))
      ).toEqual([false, false, false, false]);
    }
  });
});

describe('who may act', () => {
  it('admins and the recruiter team', () => {
    expect(mayActOnDrafts({ admin: true, recruiter: null, dept: null })).toBe(
      true
    );
    expect(
      mayActOnDrafts({ admin: false, recruiter: 'member', dept: null })
    ).toBe(true);
    expect(
      mayActOnDrafts({ admin: false, recruiter: null, dept: 'lead' })
    ).toBe(false);
    expect(mayActOnDrafts(null)).toBe(false);
  });

  it('drafts only on an open chat', () => {
    expect(canRunAgents(true, null)).toBe(true);
    expect(canRunAgents(true, '2026-11-16T00:00:00Z')).toBe(false);
    expect(canRunAgents(false, null)).toBe(false);
  });
});

describe('runMessage', () => {
  it('words each outcome', () => {
    expect(runMessage({ data: { outcome: 'drafted' } })).toEqual({
      key: 'agents.run.drafted',
      tone: 'success',
    });
    expect(runMessage({ data: { outcome: 'handoff' } }).key).toBe(
      'agents.run.handoff'
    );
    expect(runMessage({ data: { outcome: 'opted_out' } }).key).toBe(
      'agents.run.optedOut'
    );
  });

  it('gives every route error a message key that exists', () => {
    for (const code of RUN_ERRORS) {
      const m = runMessage({ error: code });
      expect(hasKey(m.key), `${code} -> ${m.key}`).toBe(true);
    }
    expect(runMessage({ error: 'agents_off' }).key).toBe(
      'agents.run.agentsOff'
    );
    expect(runMessage({ error: 'limit' }).key).toBe('agents.run.limit');
    expect(runMessage({ error: 'forbidden' }).key).toBe('agents.run.failed');
    expect(runMessage({ error: 'something_new' }).key).toBe(
      'agents.run.failed'
    );
  });
});

describe('decideErrorKey', () => {
  it('words ALREADY_DECIDED and every other code with an existing key', () => {
    expect(decideErrorKey('ALREADY_DECIDED')).toBe('agents.alreadyDecided');
    for (const code of HR_ERROR_CODES) {
      expect(hasKey(decideErrorKey(code)), code).toBe(true);
    }
  });
});

describe('parseSlots', () => {
  it('splits on commas and drops blanks', () => {
    expect(parseSlots(' Mon 10:00 , ,Tue 14:00 ')).toEqual({
      slots: ['Mon 10:00', 'Tue 14:00'],
    });
    expect(parseSlots('')).toEqual({ slots: [] });
  });

  it('accepts five and rejects six slots', () => {
    expect(parseSlots('a,b,c,d,e')).toEqual({
      slots: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(parseSlots('a,b,c,d,e,f')).toEqual({ error: 'tooMany' });
  });

  it('accepts 80 and rejects 81 characters', () => {
    expect(parseSlots('x'.repeat(80))).toEqual({ slots: ['x'.repeat(80)] });
    expect(parseSlots(`a,${'x'.repeat(81)}`)).toEqual({ error: 'tooLong' });
  });
});

describe('labels', () => {
  it('has a label for every agent, intent, hand-off reason and status', () => {
    for (const k of AGENT_KINDS) expect(hasKey(agentKindKey(k)), k).toBe(true);
    for (const i of INTENTS) expect(hasKey(intentKey(i)), i).toBe(true);
    for (const r of HANDOFF_REASONS)
      expect(hasKey(handoffKey(r)), r).toBe(true);
    for (const s of DRAFT_STATUSES)
      expect(hasKey(draftStatusKey(s)), s).toBe(true);
  });
});
