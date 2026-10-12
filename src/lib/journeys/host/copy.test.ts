import { describe, expect, it } from 'vitest';
import { SHIPPED_WORKFLOW } from '../workflow';
import {
  DEFAULT_COPY,
  LIST_ROW_TITLE_MAX,
  REPLY_BUTTON_TITLE_MAX,
  mergeCopy,
  payloadForReply,
  renderSession,
} from './copy';

const templates = Object.entries(SHIPPED_WORKFLOW.templates);

describe('journey copy: the defaults cover the shipped registry', () => {
  it('has copy for every SESSION message', () => {
    const session = templates.filter(([, t]) => t.category === 'SESSION');
    expect(session.map(([n]) => n).sort()).toEqual(
      Object.keys(DEFAULT_COPY.messages).sort()
    );
  });

  it('has a title within WhatsApp limits for every payload id', () => {
    const ids = new Set(templates.flatMap(([, t]) => t.buttons));
    for (const id of ids) {
      const title = DEFAULT_COPY.titles[id];
      expect(title, id).toBeTruthy();
      expect([...title].length, id).toBeLessThanOrEqual(REPLY_BUTTON_TITLE_MAX);
    }
    expect(Object.keys(DEFAULT_COPY.titles).sort()).toEqual([...ids].sort());
  });
});

describe('renderSession', () => {
  const t = SHIPPED_WORKFLOW.templates;

  it('welcome_menu: reply buttons whose ids are the payload ids', () => {
    expect(renderSession('welcome_menu', t.welcome_menu, DEFAULT_COPY)).toEqual(
      {
        kind: 'buttons',
        body: DEFAULT_COPY.messages.welcome_menu.body,
        buttons: [
          { id: 'POS', title: 'POS terminal' },
          { id: 'ACCOUNT', title: 'Business account' },
          { id: 'LOAN', title: 'Business loan' },
        ],
      }
    );
  });

  it('pos_pitch_in_window: a list of five rows', () => {
    const m = renderSession(
      'pos_pitch_in_window',
      t.pos_pitch_in_window,
      DEFAULT_COPY
    );
    expect(m).toMatchObject({ kind: 'list', buttonLabel: 'Choose an option' });
    expect(m?.kind === 'list' && m.rows.map((r) => r.id)).toEqual([
      'QUOTE',
      'COMPARE',
      'ADVISOR',
      'NOT_NOW',
      'CALL_ME_BACK',
    ]);
  });

  it('callback_ack: text chosen by variant', () => {
    const ack = (v?: string) =>
      renderSession('callback_ack', t.callback_ack, DEFAULT_COPY, v);
    expect(ack('IN_HOURS')).toEqual({
      kind: 'text',
      text: 'An advisor will call you shortly.',
    });
    expect(ack('OUT_OF_HOURS')).toEqual({
      kind: 'text',
      text: 'An advisor will call you tomorrow from 9 am.',
    });
    expect(ack()).toEqual({
      kind: 'text',
      text: 'An advisor will call you shortly.',
    });
  });

  it('clips an overridden title to the button / row limit and answers null without copy', () => {
    const copy = mergeCopy({
      titles: { POS: 'A very long point of sale title' },
    });
    const b = renderSession('welcome_menu', t.welcome_menu, copy);
    expect(b?.kind === 'buttons' && [...b.buttons[0].title].length).toBe(
      REPLY_BUTTON_TITLE_MAX
    );
    const copy2 = mergeCopy({
      titles: { QUOTE: 'A very long quote row title here' },
    });
    const l = renderSession(
      'pos_pitch_in_window',
      t.pos_pitch_in_window,
      copy2
    );
    expect(l?.kind === 'list' && [...l.rows[0].title].length).toBe(
      LIST_ROW_TITLE_MAX
    );
    expect(renderSession('pos_quote', t.pos_quote, DEFAULT_COPY)).toBeNull();
  });
});

describe('mergeCopy', () => {
  it('lays account overrides over the defaults and ignores junk', () => {
    const c = mergeCopy({
      messages: {
        welcome_menu: { body: 'Hi there!' },
        callback_ack: { variants: { OUT_OF_HOURS: 'Tomorrow at 10.' } },
        acct_pitch_in_window: { body: 42 },
        loan_pitch_in_window: 'nope',
      },
      titles: { NOT_NOW: 'Later', LOAN: '  ', POS: 7 },
    });
    expect(c.messages.welcome_menu.body).toBe('Hi there!');
    expect(c.messages.callback_ack.variants).toEqual({
      IN_HOURS: 'An advisor will call you shortly.',
      OUT_OF_HOURS: 'Tomorrow at 10.',
    });
    expect(c.messages.acct_pitch_in_window).toEqual(
      DEFAULT_COPY.messages.acct_pitch_in_window
    );
    expect(c.messages.loan_pitch_in_window).toEqual(
      DEFAULT_COPY.messages.loan_pitch_in_window
    );
    expect(c.titles).toEqual({ ...DEFAULT_COPY.titles, NOT_NOW: 'Later' });
    expect(mergeCopy(null)).toEqual(DEFAULT_COPY);
    expect(DEFAULT_COPY.titles.NOT_NOW).toBe('Not now');
  });
});

describe('payloadForReply', () => {
  it('maps a payload id, a default title or an account title to the payload', () => {
    const copy = mergeCopy({ titles: { NOT_NOW: 'Maybe later' } });
    expect(payloadForReply('CALL_ME_BACK')).toBe('CALL_ME_BACK');
    expect(payloadForReply('  call ME   back ')).toBe('CALL_ME_BACK');
    expect(payloadForReply('Maybe later', copy)).toBe('NOT_NOW');
    expect(payloadForReply('Not now', copy)).toBe('NOT_NOW');
    expect(payloadForReply('Get a quote', copy)).toBe('QUOTE');
  });

  it('answers null for free text', () => {
    expect(payloadForReply('hello, what are your rates?')).toBeNull();
    expect(payloadForReply('   ')).toBeNull();
  });
});
