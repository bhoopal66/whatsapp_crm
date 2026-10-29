import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import {
  REPLY_CLASSES,
  REPLY_CLASS_QS_VERSION,
  REPLY_CLASS_QUESTIONS,
} from './questions/reply-class';
import { buildReplyClassState } from './checks/reply-class';

const input = {
  accountId: TEST_ACCOUNT,
  campaignMessage: 'Hi, a 0% card offer is open this week. Reply YES.',
  reply: 'yes how do I apply',
};

describe('reply-class questions', () => {
  it('asks one choice over the seven classes, in 148 CHECK order', () => {
    expect(REPLY_CLASS_QS_VERSION).toBe('qs-reply-class-v1');
    expect(Object.keys(REPLY_CLASS_QUESTIONS)).toEqual(['reply_class']);
    expect(REPLY_CLASS_QUESTIONS.reply_class.type).toBe('choice');
    expect(Object.keys(REPLY_CLASSES)).toEqual([
      'interested',
      'question',
      'not_now',
      'not_interested',
      'wrong_person',
      'stop',
      'other',
    ]);
  });

  it('builds a redacted, clipped state', () => {
    const s = buildReplyClassState({
      campaignMessage: 'x'.repeat(3000),
      reply: 'call me on 0501234567 ' + 'y'.repeat(2000),
      tappedButton: '  ',
    });
    expect(s.campaign_message.length).toBeLessThanOrEqual(1500);
    expect(s.reply.length).toBeLessThanOrEqual(1000);
    expect(s.reply).not.toContain('0501234567');
    expect(s.tapped_button).toBeNull();
    expect(
      buildReplyClassState({ ...input, tappedButton: 'Yes please' })
        .tapped_button
    ).toBe('Yes please');
  });
});

describe('DecisionLayer.replyClass (through the real SDK)', () => {
  it('returns the class with its probability', async () => {
    const sim = makeSim(() => ({
      answers: { reply_class: { choice: 'interested', confidence: 0.9 } },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.replyClass(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cls).toBe('interested');
    // the simulator spreads 0.9 confidence over seven options: (0.9·6+1)/7
    expect(r.p).toBeCloseTo(6.4 / 7, 6);
    expect(sim.calls).toHaveLength(1);
    expect(sim.calls[0]!.body.state).toMatchObject({
      campaign_message: input.campaignMessage,
      reply: input.reply,
      tapped_button: null,
    });
  });

  it('gives up at the hard deadline: ok false, TIMEOUT', async () => {
    const sim = makeSim(() => 'hang');
    const { layer } = makeLayer({ sim, config: { timeoutMs: 5000 } });
    const r = await layer.replyClass({ ...input, deadlineMs: 60 });
    expect(r).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.replyClass(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('never calls TypeSafe for an account outside TS_ACCOUNT_IDS', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await layer.replyClass(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('has its own breaker: an outage does not touch route', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim });
    for (let i = 0; i < 5; i++) await layer.replyClass(input);
    expect(layer.gateway.available('reply_class')).toBe(false);
    expect(layer.gateway.available('route')).toBe(true);
  });
});
