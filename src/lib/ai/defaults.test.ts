import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults';

describe('buildSystemPrompt — grounding stance', () => {
  const knowledge = ['RAKBANK: zero opening fee.'];

  it('prefers the excerpts by default', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge,
    });
    expect(p).toContain('Prefer these for any specifics');
    expect(p).not.toContain('ONLY source of facts');
    expect(p).toContain('RAKBANK: zero opening fee.');
  });

  it('makes the excerpts the only source when strict grounding is on', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge,
      strictGrounding: true,
    });
    expect(p).toContain('ONLY source of facts');
    expect(p).not.toContain('Prefer these for any specifics');
    expect(p).toContain(HANDOFF_SENTINEL);
  });

  it('forbids stating facts when strict and nothing was retrieved (auto-reply)', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: [],
      strictGrounding: true,
    });
    expect(p).toContain('No knowledge-base excerpts were retrieved');
    expect(p).toContain(HANDOFF_SENTINEL);
  });

  it('asks for a follow-up instead of the sentinel in draft mode', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      knowledge: [],
      strictGrounding: true,
    });
    expect(p).toContain('No knowledge-base excerpts were retrieved');
    expect(p).toContain("say you'll check and follow up");
    // The draft scaffold never teaches the auto-reply handoff protocol.
    expect(p).not.toContain('replying automatically');
  });

  it('adds nothing about excerpts when not strict and none were retrieved', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: [],
    });
    expect(p).not.toContain('Knowledge base');
    expect(p).not.toContain('No knowledge-base excerpts');
  });
});
