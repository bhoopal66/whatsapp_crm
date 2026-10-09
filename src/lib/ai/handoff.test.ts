import { describe, it, expect } from 'vitest';
import {
  buildHandoffSummary,
  describeHandoffReason,
  upperFirst,
} from './handoff';

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    });
    expect(summary).toBe(
      '🤖 AI needs a person after 2 replies. Last customer message: “I want a refund”'
    );
  });

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    });
    expect(summary).toContain('after 1 reply.');
  });

  it('says "before replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    });
    expect(summary).toContain('AI needs a person before replying.');
    expect(summary).toContain('“agent please”');
  });

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    });
    expect(summary).toContain('“second”');
  });

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300);
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    });
    expect(summary).toContain('…');
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250);
  });

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    });
    expect(summary).toBe('🤖 AI needs a person before replying.');
  });
});

describe('buildHandoffSummary — reason clause (migration 052)', () => {
  const messages = [{ role: 'user' as const, content: 'I want a refund' }];

  it('names the escalation keyword', () => {
    const s = buildHandoffSummary({
      messages,
      replyCount: 0,
      reason: 'keyword',
      detail: 'refund',
    });
    expect(s).toBe(
      "🤖 AI needs a person before replying: the customer's message matched the escalation keyword “refund”. Last customer message: “I want a refund”"
    );
  });

  it('names a knowledge gap with its score', () => {
    const s = buildHandoffSummary({
      messages,
      replyCount: 1,
      reason: 'no_knowledge',
      detail: 'best similarity 0.21 < 0.40',
    });
    expect(s).toContain(
      'the knowledge base has nothing close enough to answer from (best similarity 0.21 < 0.40).'
    );
  });

  it('truncates a long provider error', () => {
    const s = buildHandoffSummary({
      messages,
      replyCount: 0,
      reason: 'error',
      detail: 'x'.repeat(300),
    });
    expect(s).toContain('the AI provider failed (');
    expect(s.length).toBeLessThan(300);
  });

  it('says the model asked when the reason is model', () => {
    const s = buildHandoffSummary({ messages, replyCount: 2, reason: 'model' });
    expect(s).toContain(
      'after 2 replies: the AI was unsure and asked for a person.'
    );
  });

  it('lets reasonText replace the clause the reason code would give', () => {
    const s = buildHandoffSummary({
      messages,
      replyCount: 1,
      reason: 'error',
      detail: 'ignored',
      reasonText: 'Reason: WhatsApp did not deliver the last bot reply.',
    });
    expect(s).toContain('Reason: WhatsApp did not deliver the last bot reply.');
    expect(s).not.toContain('AI provider failed');
  });

  it('ignores a blank reasonText', () => {
    const s = buildHandoffSummary({
      messages,
      replyCount: 0,
      reason: 'error',
      reasonText: '  ',
    });
    expect(s).toContain('before replying: the AI provider failed.');
  });
});

describe('buildHandoffSummary — a note a person can act on', () => {
  it('leads with "AI needs a person" and the guardrail sentence, then the customer', () => {
    const s = buildHandoffSummary({
      messages: [{ role: 'user', content: 'Hi' }],
      replyCount: 0,
      reason: 'guardrail',
      detail:
        'the safety check blocked the draft reply because the draft named a bank that is not on your partner list (FAB). (code: CODE_NON_PARTNER_BANK) Draft: “FAB…” The AI was also unsure and asked for a person.',
    });
    expect(s).toBe(
      '🤖 AI needs a person before replying: the safety check blocked the draft reply because the draft named a bank that is not on your partner list (FAB). (code: CODE_NON_PARTNER_BANK) Draft: “FAB…” The AI was also unsure and asked for a person. Last customer message: “Hi”'
    );
  });

  it('upperFirst makes a reason stand alone (the bell)', () => {
    expect(upperFirst(describeHandoffReason('model'))).toBe(
      'The AI was unsure and asked for a person.'
    );
  });
});
