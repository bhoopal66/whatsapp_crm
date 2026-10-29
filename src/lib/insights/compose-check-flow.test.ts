import { describe, expect, it } from 'vitest';
import {
  composeFlow,
  initialComposeFlow,
  takeParkedDraft,
  type ComposeFlowEffect,
  type ComposeFlowEvent,
  type ComposeFlowState,
  type ParkedDraft,
  type ParkedDrafts,
} from './compose-check-flow';

// The composer's check/send/park decisions, driven as the composer
// drives them: every effect is applied to a small fake composer.

type Reply = { id: string };
type P = { label: string };

function harness() {
  let state: ComposeFlowState<P, Reply> = initialComposeFlow();
  const sent: string[] = [];
  const effects: ComposeFlowEffect<P, Reply>[] = [];
  const stash: ParkedDrafts<Reply> = new Map();
  const box = { text: '' };
  const dispatch = (event: ComposeFlowEvent<P, Reply>) => {
    const step = composeFlow(state, event);
    state = step.state;
    effects.push(...step.effects);
    for (const e of step.effects) {
      if (e.type === 'send') sent.push(e.payload.label);
      if (e.type === 'park') stash.set(e.conversationId, e.draft);
      if (e.type === 'clearBox') box.text = '';
    }
    return step;
  };
  const submit = (
    text: string,
    opts: {
      conversationId?: string;
      focus?: 'text' | 'caption';
      mode?: 'warn' | 'off';
      reply?: Reply | null;
    } = {}
  ) => {
    const focus = opts.focus ?? 'text';
    if (focus === 'text') box.text = text;
    return dispatch({
      type: 'submit',
      mode: opts.mode ?? 'warn',
      conversationId: opts.conversationId ?? 'chat-a',
      text,
      focus,
      payload: { label: text },
      park:
        focus === 'text'
          ? { text, reply: opts.reply ?? null, origin: null }
          : null,
      contactName: 'Aisha',
    });
  };
  const lastToken = () => {
    const check = [...effects].reverse().find((e) => e.type === 'check');
    return (check as { token: number }).token;
  };
  return {
    dispatch,
    submit,
    lastToken,
    sent,
    effects,
    stash,
    box,
    state: () => state,
  };
}

const LONG = 'Your loan is approved for sure';

describe('compose check flow: sending', () => {
  it('sends at once with the mode off or a short draft, never checking', () => {
    const h = harness();
    h.submit(LONG, { mode: 'off' });
    h.submit('ok thanks');
    expect(h.sent).toEqual([LONG, 'ok thanks']);
    expect(h.effects.some((e) => e.type === 'check')).toBe(false);
    expect(h.state().phase).toBe('idle');
  });

  it('sends when the check answers send, which a timeout or error does', () => {
    const h = harness();
    h.submit(LONG);
    expect(h.sent).toEqual([]);
    expect(h.state().phase).toBe('checking');
    h.dispatch({
      type: 'answer',
      token: h.lastToken(),
      decision: { kind: 'send' },
    });
    expect(h.sent).toEqual([LONG]);
    expect(h.state().phase).toBe('idle');
  });

  it('ignores a second submit while checking or reviewing', () => {
    const h = harness();
    h.submit(LONG);
    h.submit(LONG);
    expect(h.effects.filter((e) => e.type === 'check')).toHaveLength(1);
    h.dispatch({
      type: 'answer',
      token: h.lastToken(),
      decision: { kind: 'review', warnings: ['promise'], eventId: 'ev-1' },
    });
    h.submit(LONG);
    expect(h.effects.filter((e) => e.type === 'check')).toHaveLength(1);
    h.dispatch({ type: 'sendAnyway' });
    h.dispatch({ type: 'sendAnyway' });
    expect(h.sent).toEqual([LONG]);
    expect(h.effects).toContainEqual({
      type: 'report',
      eventId: 'ev-1',
      outcome: 'sent_anyway',
    });
  });

  it('sends nothing for a caption whose attachment was discarded', () => {
    const h = harness();
    h.submit('Here is the form you need', { focus: 'caption' });
    const token = h.lastToken();
    h.dispatch({ type: 'discardAttachment' });
    expect(h.effects).toContainEqual({ type: 'abort' });
    h.dispatch({ type: 'answer', token, decision: { kind: 'send' } });
    expect(h.sent).toEqual([]);
    expect(h.state().phase).toBe('idle');
  });

  it('Edit message sends nothing and reports edited', () => {
    const h = harness();
    h.submit(LONG);
    h.dispatch({
      type: 'answer',
      token: h.lastToken(),
      decision: { kind: 'review', warnings: ['promise'], eventId: 'ev-2' },
    });
    h.dispatch({ type: 'edit' });
    expect(h.sent).toEqual([]);
    expect(h.effects).toContainEqual({
      type: 'report',
      eventId: 'ev-2',
      outcome: 'edited',
    });
  });
});

describe('compose check flow: switching chats', () => {
  it('parks the text for the original chat, empties the box and says so', () => {
    const h = harness();
    const reply = { id: 'msg-9' };
    h.submit(LONG, { reply });
    const token = h.lastToken();
    h.dispatch({ type: 'switch', to: 'chat-b', boxText: h.box.text });
    expect(h.effects).toContainEqual({ type: 'abort' });
    expect(h.stash.get('chat-a')).toEqual({
      text: LONG,
      reply,
      origin: null,
    });
    expect(h.box.text).toBe('');
    expect(h.effects).toContainEqual({
      type: 'notifyParked',
      contactName: 'Aisha',
    });
    // The aborted check's late answer sends nothing, anywhere.
    h.dispatch({ type: 'answer', token, decision: { kind: 'send' } });
    expect(h.sent).toEqual([]);
  });

  it('puts the parked text back when the chat is shown again', () => {
    const h = harness();
    h.submit(LONG);
    h.dispatch({ type: 'switch', to: 'chat-b', boxText: h.box.text });
    expect(takeParkedDraft(h.stash, 'chat-b', '')).toBeNull();
    const back = takeParkedDraft(h.stash, 'chat-a', '');
    expect(back?.text).toBe(LONG);
    expect(h.stash.has('chat-a')).toBe(false);
  });

  it('keeps a parked draft while the box holds other text', () => {
    const stash: ParkedDrafts<Reply> = new Map();
    const parked: ParkedDraft<Reply> = {
      text: LONG,
      reply: null,
      origin: null,
    };
    stash.set('chat-a', parked);
    expect(takeParkedDraft(stash, 'chat-a', 'typed meanwhile')).toBeNull();
    expect(stash.get('chat-a')).toBe(parked);
  });

  it('clears a stale review on a switch, reports edited, and parks', () => {
    const h = harness();
    h.submit(LONG);
    h.dispatch({
      type: 'answer',
      token: h.lastToken(),
      decision: { kind: 'review', warnings: ['terms'], eventId: 'ev-3' },
    });
    h.dispatch({ type: 'switch', to: 'chat-b', boxText: h.box.text });
    expect(h.state().phase).toBe('idle');
    expect(h.effects).toContainEqual({
      type: 'report',
      eventId: 'ev-3',
      outcome: 'edited',
    });
    expect(h.stash.get('chat-a')?.text).toBe(LONG);
    // "Send anyway" from the old dialog can no longer send.
    h.dispatch({ type: 'sendAnyway' });
    expect(h.sent).toEqual([]);
  });

  it('does nothing on a switch with no check open, or to the same chat', () => {
    const h = harness();
    h.dispatch({ type: 'switch', to: 'chat-b', boxText: 'typed' });
    h.submit(LONG);
    h.dispatch({ type: 'switch', to: 'chat-a', boxText: LONG });
    expect(h.state().phase).toBe('checking');
    expect(h.stash.size).toBe(0);
  });

  it('a caption check parks nothing: the attachment stays staged', () => {
    const h = harness();
    h.submit('Here is the form you need', { focus: 'caption' });
    h.dispatch({ type: 'switch', to: 'chat-b', boxText: '' });
    expect(h.effects).toContainEqual({ type: 'abort' });
    expect(h.stash.size).toBe(0);
    expect(h.effects.some((e) => e.type === 'notifyParked')).toBe(false);
    expect(h.sent).toEqual([]);
  });
});
