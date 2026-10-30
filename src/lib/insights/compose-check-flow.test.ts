import { describe, expect, it } from 'vitest';
import {
  clearParkedDrafts,
  composeFlow,
  initialComposeFlow,
  lateUploadLanding,
  parkDraft,
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
type Att = { filename: string; caption: string };

function harness() {
  let state: ComposeFlowState<P, Reply, Att> = initialComposeFlow();
  const sent: string[] = [];
  const effects: ComposeFlowEffect<P, Reply, Att>[] = [];
  const stash: ParkedDrafts<Reply, Att> = new Map();
  const box: { text: string; origin: string | null } = {
    text: '',
    origin: null,
  };
  const composer: {
    shown: string | null;
    staged: Att | null;
    reply: Reply | null;
  } = { shown: 'chat-a', staged: null, reply: null };
  const dispatch = (event: ComposeFlowEvent<P, Reply, Att>) => {
    const step = composeFlow(state, event);
    state = step.state;
    effects.push(...step.effects);
    for (const e of step.effects) {
      if (e.type === 'send') sent.push(e.payload.label);
      if (e.type === 'park') parkDraft(stash, e.conversationId, e.draft);
      if (e.type === 'clearBox') Object.assign(box, { text: '', origin: null });
      if (e.type === 'clearAttachment') composer.staged = null;
      if (e.type === 'clearReply') composer.reply = null;
    }
    return step;
  };
  // As the composer does: park for the chat left, then take back what
  // is parked for the chat opened.
  const switchTo = (to: string | null) => {
    const step = dispatch({
      type: 'switch',
      from: composer.shown,
      to,
      boxText: box.text,
      boxOrigin: box.origin,
      staged: composer.staged,
      reply: composer.reply,
    });
    composer.shown = to;
    return step;
  };
  const open = (to: string) => {
    switchTo(to);
    const back = takeParkedDraft(stash, to, box.text, composer.staged !== null);
    if (!back) return;
    if (back.text) Object.assign(box, { text: back.text, origin: back.origin });
    if (back.attachment) composer.staged = back.attachment;
    if (back.reply) composer.reply = back.reply;
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
    else composer.staged = { filename: 'offer.pdf', caption: text };
    return dispatch({
      type: 'submit',
      mode: opts.mode ?? 'warn',
      conversationId: opts.conversationId ?? 'chat-a',
      text,
      focus,
      payload: { label: text },
      park:
        focus === 'text'
          ? { text, reply: opts.reply ?? null, origin: null, attachment: null }
          : {
              text: '',
              reply: opts.reply ?? null,
              origin: null,
              attachment: composer.staged,
            },
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
    switchTo,
    open,
    stash,
    box,
    composer,
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
    h.switchTo('chat-b');
    expect(h.effects).toContainEqual({ type: 'abort' });
    expect(h.stash.get('chat-a')).toEqual({
      text: LONG,
      reply,
      origin: null,
      attachment: null,
    });
    expect(h.box.text).toBe('');
    expect(h.effects).toContainEqual({
      type: 'notifyParked',
      contactName: 'Aisha',
      what: 'text',
    });
    // The aborted check's late answer sends nothing, anywhere.
    h.dispatch({ type: 'answer', token, decision: { kind: 'send' } });
    expect(h.sent).toEqual([]);
  });

  it('puts the parked text back when the chat is shown again', () => {
    const h = harness();
    h.submit(LONG);
    h.switchTo('chat-b');
    expect(takeParkedDraft(h.stash, 'chat-b', '')).toBeNull();
    const back = takeParkedDraft(h.stash, 'chat-a', '');
    expect(back?.text).toBe(LONG);
    expect(h.stash.has('chat-a')).toBe(false);
  });

  it('keeps a parked draft while the box holds other text', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    const parked: ParkedDraft<Reply, Att> = {
      text: LONG,
      reply: null,
      origin: null,
      attachment: null,
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
    h.switchTo('chat-b');
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

  it('does nothing on a switch to the same chat, mid-check or not', () => {
    const h = harness();
    h.box.text = 'typed';
    h.switchTo('chat-a');
    expect(h.box.text).toBe('typed');
    h.submit(LONG);
    h.switchTo('chat-a');
    expect(h.state().phase).toBe('checking');
    expect(h.stash.size).toBe(0);
  });

  it('a caption check parks the staged attachment and unstages it', () => {
    const h = harness();
    const reply = { id: 'msg-4' };
    const caption = 'Here is the form you need';
    h.submit(caption, { focus: 'caption', reply });
    const token = h.lastToken();
    h.switchTo('chat-b');
    expect(h.effects).toContainEqual({ type: 'abort' });
    // Nothing of chat A's is left staged in chat B's composer.
    expect(h.composer.staged).toBeNull();
    expect(h.stash.get('chat-a')).toEqual({
      text: '',
      reply,
      origin: null,
      attachment: { filename: 'offer.pdf', caption },
    });
    expect(h.effects).toContainEqual({
      type: 'notifyParked',
      contactName: 'Aisha',
      what: 'attachment',
    });
    // The box is not the caption's: it is left alone.
    expect(h.effects.some((e) => e.type === 'clearBox')).toBe(false);
    h.dispatch({ type: 'answer', token, decision: { kind: 'send' } });
    expect(h.sent).toEqual([]);
  });

  it('parks the attachment as it is under the dialog', () => {
    const h = harness();
    h.submit('Here is the form you need', { focus: 'caption' });
    h.dispatch({
      type: 'answer',
      token: h.lastToken(),
      decision: { kind: 'review', warnings: ['promise'], eventId: 'ev-5' },
    });
    h.composer.staged = { filename: 'offer.pdf', caption: 'Edited caption' };
    h.switchTo('chat-b');
    expect(h.stash.get('chat-a')?.attachment?.caption).toBe('Edited caption');
    expect(h.composer.staged).toBeNull();
    expect(h.effects).toContainEqual({
      type: 'report',
      eventId: 'ev-5',
      outcome: 'edited',
    });
  });

  it('unstages a parked attachment when the composer goes away too', () => {
    const h = harness();
    h.submit('Here is the form you need', { focus: 'caption' });
    h.switchTo(null);
    expect(h.composer.staged).toBeNull();
    expect(h.stash.get('chat-a')?.attachment?.filename).toBe('offer.pdf');
  });

  it('puts a parked attachment back only where nothing is staged', () => {
    const h = harness();
    h.submit('Here is the form you need', { focus: 'caption' });
    h.switchTo('chat-b');
    expect(takeParkedDraft(h.stash, 'chat-b', '', false)).toBeNull();
    // Something else staged in chat A: the parked one waits.
    expect(takeParkedDraft(h.stash, 'chat-a', '', true)).toBeNull();
    expect(h.stash.has('chat-a')).toBe(true);
    const back = takeParkedDraft(h.stash, 'chat-a', 'typed', false);
    expect(back?.attachment?.filename).toBe('offer.pdf');
    expect(back?.text).toBe('');
    expect(h.stash.has('chat-a')).toBe(false);
  });

  it('keeps a parked text and a parked attachment side by side', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    const att = { filename: 'offer.pdf', caption: 'Here is the form' };
    parkDraft(stash, 'chat-a', {
      text: LONG,
      reply: null,
      origin: 'missed_call_draft',
      attachment: null,
    });
    parkDraft(stash, 'chat-a', {
      text: '',
      reply: null,
      origin: null,
      attachment: att,
    });
    expect(stash.get('chat-a')).toEqual({
      text: LONG,
      reply: null,
      origin: 'missed_call_draft',
      attachment: att,
    });
    // The box holds text: only the attachment goes back.
    const first = takeParkedDraft(stash, 'chat-a', 'typed', false);
    expect(first).toMatchObject({ text: '', attachment: att });
    expect(stash.get('chat-a')).toMatchObject({
      text: LONG,
      origin: 'missed_call_draft',
      attachment: null,
    });
    const second = takeParkedDraft(stash, 'chat-a', '', true);
    expect(second).toMatchObject({ text: LONG, attachment: null });
    expect(stash.has('chat-a')).toBe(false);
  });
});

describe('compose check flow: per-chat drafts with no check running', () => {
  const att = { filename: 'offer.pdf', caption: 'For Aisha only' };

  it('parks the typed text for the chat left and empties the box, silently', () => {
    const h = harness();
    Object.assign(h.box, { text: 'Hi Aisha', origin: 'missed_call_draft' });
    h.switchTo('chat-b');
    expect(h.box.text).toBe('');
    expect(h.stash.get('chat-a')).toEqual({
      text: 'Hi Aisha',
      origin: 'missed_call_draft',
      reply: null,
      attachment: null,
    });
    expect(h.effects.some((e) => e.type === 'notifyParked')).toBe(false);
    expect(h.state().phase).toBe('idle');
  });

  it('parks and unstages the staged attachment', () => {
    const h = harness();
    h.composer.staged = att;
    h.switchTo('chat-b');
    expect(h.composer.staged).toBeNull();
    expect(h.stash.get('chat-a')?.attachment).toBe(att);
    // The box was blank: it is not the attachment's to clear.
    expect(h.effects.some((e) => e.type === 'clearBox')).toBe(false);
  });

  it('parks the reply quote and drops it from the composer', () => {
    const h = harness();
    h.composer.reply = { id: 'msg-7' };
    h.switchTo('chat-b');
    expect(h.composer.reply).toBeNull();
    expect(h.stash.get('chat-a')).toEqual({
      text: '',
      origin: null,
      reply: { id: 'msg-7' },
      attachment: null,
    });
  });

  it('parks nothing when the box is blank and nothing is staged or quoted', () => {
    const h = harness();
    h.box.text = '   ';
    h.switchTo('chat-b');
    expect(h.effects).toEqual([]);
    expect(h.stash.size).toBe(0);
  });

  it('parks nothing on the first show', () => {
    const h = harness();
    h.composer.shown = null;
    h.box.text = 'typed';
    h.switchTo('chat-a');
    expect(h.effects).toEqual([]);
  });

  it('puts the whole draft back on return, and only there', () => {
    const h = harness();
    h.box.text = 'Hi Aisha';
    h.composer.staged = att;
    h.composer.reply = { id: 'msg-7' };
    h.open('chat-b');
    // Chat B shows nothing of chat A's.
    expect(h.box.text).toBe('');
    expect(h.composer.staged).toBeNull();
    expect(h.composer.reply).toBeNull();
    h.open('chat-a');
    expect(h.box.text).toBe('Hi Aisha');
    expect(h.composer.staged).toBe(att);
    expect(h.composer.reply).toEqual({ id: 'msg-7' });
    expect(h.stash.size).toBe(0);
  });

  it("never restores another chat's draft into this one", () => {
    const h = harness();
    h.box.text = 'For Aisha';
    h.open('chat-b');
    h.box.text = 'For Omar';
    h.open('chat-c');
    expect(h.box.text).toBe('');
    h.open('chat-b');
    expect(h.box.text).toBe('For Omar');
    h.open('chat-a');
    expect(h.box.text).toBe('For Aisha');
    expect(h.stash.get('chat-b')?.text).toBe('For Omar');
  });

  it('a quote parked alone comes back alone', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    parkDraft(stash, 'chat-a', {
      text: '',
      origin: null,
      reply: { id: 'msg-7' },
      attachment: null,
    });
    expect(takeParkedDraft(stash, 'chat-a', '')).toEqual({
      text: '',
      origin: null,
      reply: { id: 'msg-7' },
      attachment: null,
    });
    expect(stash.has('chat-a')).toBe(false);
  });

  it('leaving the inbox parks the draft and unstages, keeping the box', () => {
    const h = harness();
    h.box.text = 'Hi Aisha';
    h.composer.staged = att;
    h.composer.reply = { id: 'msg-7' };
    h.switchTo(null);
    // Unstaged, so the unmount cleanup does not delete it.
    expect(h.composer.staged).toBeNull();
    expect(h.effects.some((e) => e.type === 'clearBox')).toBe(false);
    expect(h.effects.some((e) => e.type === 'clearReply')).toBe(false);
    expect(h.stash.get('chat-a')).toEqual({
      text: 'Hi Aisha',
      origin: null,
      reply: { id: 'msg-7' },
      attachment: att,
    });
  });

  it('a switch mid-check also parks what the check does not hold', () => {
    const h = harness();
    // Typed before the attachment hid the box, then a caption check.
    h.box.text = 'typed earlier';
    h.submit('Here is the form you need', { focus: 'caption' });
    h.switchTo('chat-b');
    expect(h.box.text).toBe('');
    expect(h.stash.get('chat-a')).toMatchObject({
      text: 'typed earlier',
      attachment: { filename: 'offer.pdf' },
    });
    // The check's own notice, once.
    expect(h.effects.filter((e) => e.type === 'notifyParked')).toHaveLength(1);
  });

  it('parking an attachment over a parked one hands back the older', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    const older = { filename: 'old.pdf', caption: '' };
    const draft = (attachment: Att | null) => ({
      text: '',
      origin: null,
      reply: null,
      attachment,
    });
    expect(parkDraft(stash, 'chat-a', draft(older))).toBeNull();
    expect(parkDraft(stash, 'chat-a', draft(null))).toBeNull();
    expect(parkDraft(stash, 'chat-a', draft(att))).toBe(older);
    expect(stash.get('chat-a')?.attachment).toBe(att);
    expect(parkDraft(stash, 'chat-a', draft(att))).toBeNull();
  });
});

describe('clearParkedDrafts', () => {
  it('empties the stash and returns every parked attachment', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    const a = { filename: 'a.pdf', caption: '' };
    const b = { filename: 'b.png', caption: '' };
    const draft = (attachment: Att | null, text = '') => ({
      text,
      origin: null,
      reply: null,
      attachment,
    });
    stash.set('chat-a', draft(a));
    stash.set('chat-b', draft(null, 'just text'));
    stash.set('chat-c', draft(b));
    expect(clearParkedDrafts(stash)).toEqual([a, b]);
    expect(stash.size).toBe(0);
  });

  it('returns nothing from an empty stash', () => {
    const stash: ParkedDrafts<Reply, Att> = new Map();
    expect(clearParkedDrafts(stash)).toEqual([]);
  });
});

describe('lateUploadLanding', () => {
  const at = (
    startedIn: string | null,
    openChat: string | null,
    ownerAtStart: string | null,
    ownerNow: string | null
  ) => lateUploadLanding({ startedIn, openChat, ownerAtStart, ownerNow });

  it('stages an upload that lands in the chat it was started in', () => {
    expect(at('a', 'a', 'u1', 'u1')).toBe('stage');
    expect(at(null, 'b', 'u1', 'u1')).toBe('stage');
  });

  it('parks it for its chat when the agent moved on', () => {
    expect(at('a', 'b', 'u1', 'u1')).toBe('park');
    expect(at('a', null, 'u1', 'u1')).toBe('park');
  });

  it('discards it when another login took the stash meanwhile', () => {
    expect(at('a', 'b', 'u1', 'u2')).toBe('discard');
    expect(at('a', null, 'u1', 'u2')).toBe('discard');
    expect(at('a', null, null, 'u2')).toBe('discard');
  });
});
