import { describe, expect, it } from 'vitest';

import { SHIPPED_WORKFLOW as DEF } from './workflow';
import { DEFAULT_COPY, mergeCopy } from './host/copy';
import {
  blankMessageForm,
  copyFormFrom,
  copyOverrides,
  copyProblems,
  parseTaamulDid,
  rowForSend,
  sameOverrides,
  sessionMessages,
  sessionTitleLimits,
  templateChecklist,
  textLength,
  type CopyForm,
} from './settings-ui';

const blankForm = (): CopyForm => copyFormFrom(null, DEFAULT_COPY);
const item = (items: ReturnType<typeof templateChecklist>, name: string) =>
  items.find((i) => i.name === name)!;

describe('templateChecklist', () => {
  it('lists every MARKETING and UTILITY template, in workflow order, and no SESSION message', () => {
    const items = templateChecklist(DEF, [], ['meta', 'whapi']);
    const expected = Object.entries(DEF.templates)
      .filter(([, t]) => t.category !== 'SESSION')
      .map(([n]) => n);
    expect(items.map((i) => i.name)).toEqual(expected);
    expect(items).toHaveLength(25);
    for (const name of ['welcome_menu', 'pos_pitch_in_window', 'callback_ack'])
      expect(items.some((i) => i.name === name)).toBe(false);
  });

  it('carries the category, the buttons and the phone button', () => {
    const items = templateChecklist(DEF, [], ['whapi']);
    expect(item(items, 'pos_intro_offer')).toMatchObject({
      category: 'MARKETING',
      buttons: ['QUOTE', 'COMPARE', 'ADVISOR', 'NOT_NOW', 'CALL_ME_BACK'],
      phoneButton: false,
    });
    expect(item(items, 'pos_docs_request')).toMatchObject({
      category: 'UTILITY',
      phoneButton: true,
    });
  });

  it('states Meta templates as approved, pending, not approved or missing', () => {
    const items = templateChecklist(
      DEF,
      [
        { name: 'pos_quote', language: 'en_US', status: 'APPROVED' },
        { name: 'acct_intro_offer', language: 'en_US', status: 'PENDING' },
        { name: 'loan_intro_offer', language: 'en_US', status: 'in_appeal' },
        { name: 'docs_reminder', language: 'en_US', status: 'rejected' },
        { name: 'declined_rematch', language: 'en_US', status: 'DRAFT' },
      ],
      ['meta']
    );
    expect(item(items, 'pos_quote')).toMatchObject({
      meta: 'approved',
      metaStatus: 'APPROVED',
    });
    expect(item(items, 'acct_intro_offer').meta).toBe('pending');
    expect(item(items, 'loan_intro_offer').meta).toBe('pending');
    expect(item(items, 'docs_reminder')).toMatchObject({
      meta: 'notApproved',
      metaStatus: 'REJECTED',
    });
    expect(item(items, 'declined_rematch').meta).toBe('notApproved');
    expect(item(items, 'pos_rate_comparison').meta).toBe('missing');
    expect(item(items, 'pos_rate_comparison').metaStatus).toBeUndefined();
    expect(items.every((i) => i.whapi === undefined)).toBe(true);
  });

  it('judges Meta by the row a send would use, not by any approved language', () => {
    const items = templateChecklist(
      DEF,
      [
        { name: 'pos_quote', language: 'ar', status: 'APPROVED' },
        { name: 'pos_quote', language: 'en_US', status: 'PENDING' },
      ],
      ['meta']
    );
    expect(item(items, 'pos_quote').meta).toBe('pending');
  });

  it('counts any row as present on Whapi, whatever its status', () => {
    const items = templateChecklist(
      DEF,
      [{ name: 'pos_quote', language: 'en', status: 'REJECTED' }],
      ['whapi']
    );
    expect(item(items, 'pos_quote').whapi).toBe('present');
    expect(item(items, 'pos_rate_comparison').whapi).toBe('missing');
    expect(items.every((i) => i.meta === undefined)).toBe(true);
  });

  it('states nothing per number when the account has no number', () => {
    for (const i of templateChecklist(DEF, [], [])) {
      expect(i.meta).toBeUndefined();
      expect(i.whapi).toBeUndefined();
    }
  });
});

describe('rowForSend', () => {
  it('prefers en_US, then en, then the first by language', () => {
    const r = (language: string) => ({ name: 'x', language });
    expect(rowForSend([r('ar'), r('en'), r('en_US')])?.language).toBe('en_US');
    expect(rowForSend([r('fr'), r('en'), r('ar')])?.language).toBe('en');
    expect(rowForSend([r('fr'), r('ar')])?.language).toBe('ar');
    expect(rowForSend([])).toBeNull();
  });
});

describe('copyFormFrom', () => {
  it('starts blank for every default message, variant and title', () => {
    const form = blankForm();
    expect(Object.keys(form.messages)).toEqual(
      Object.keys(DEFAULT_COPY.messages)
    );
    expect(form.messages.callback_ack).toEqual({
      body: '',
      buttonLabel: '',
      variants: { IN_HOURS: '', OUT_OF_HOURS: '' },
    });
    expect(Object.keys(form.titles)).toEqual(Object.keys(DEFAULT_COPY.titles));
    expect(Object.values(form.titles).every((v) => v === '')).toBe(true);
  });

  it('fills in the saved overrides and ignores anything else', () => {
    const form = copyFormFrom(
      {
        messages: {
          welcome_menu: { body: 'Hi there' },
          callback_ack: { variants: { OUT_OF_HOURS: 'Tomorrow', BOGUS: 'x' } },
          not_a_message: { body: 'ignored' },
          pos_pitch_in_window: { body: 42 },
        },
        titles: { POS: 'POS', NOPE: 'ignored', LOAN: null },
      },
      DEFAULT_COPY
    );
    expect(form.messages.welcome_menu.body).toBe('Hi there');
    expect(form.messages.callback_ack.variants).toEqual({
      IN_HOURS: '',
      OUT_OF_HOURS: 'Tomorrow',
    });
    expect(form.messages.pos_pitch_in_window.body).toBe('');
    expect(form.messages.not_a_message).toBeUndefined();
    expect(form.titles.POS).toBe('POS');
    expect(form.titles.LOAN).toBe('');
    expect(form.titles.NOPE).toBeUndefined();
  });
});

describe('copyOverrides', () => {
  it('saves nothing for an untouched form', () => {
    expect(copyOverrides(blankForm(), DEFAULT_COPY)).toEqual({});
  });

  it('saves only values that differ from the default, trimmed', () => {
    const form = blankForm();
    form.messages.welcome_menu.body = '  Hello from Taamul!  ';
    form.messages.acct_pitch_in_window.body = ` ${DEFAULT_COPY.messages.acct_pitch_in_window.body} `;
    form.messages.pos_pitch_in_window.buttonLabel = 'Pick one';
    form.messages.callback_ack.variants.OUT_OF_HOURS = 'We call at 9.';
    form.messages.callback_ack.variants.IN_HOURS =
      DEFAULT_COPY.messages.callback_ack.variants!.IN_HOURS;
    form.titles.POS = 'Card machine';
    form.titles.LOAN = '   ';
    form.titles.ACCOUNT = DEFAULT_COPY.titles.ACCOUNT;
    form.titles.PROCEED = 'Go ahead';
    expect(copyOverrides(form, DEFAULT_COPY)).toEqual({
      messages: {
        welcome_menu: { body: 'Hello from Taamul!' },
        pos_pitch_in_window: { buttonLabel: 'Pick one' },
        callback_ack: { variants: { OUT_OF_HOURS: 'We call at 9.' } },
      },
      titles: { POS: 'Card machine', PROCEED: 'Go ahead' },
    });
  });

  it('round-trips through the saved row and merges as the bot reads it', () => {
    const form = blankForm();
    form.messages.loan_pitch_in_window.body = 'Loans!';
    form.titles.NOT_NOW = 'Later';
    const saved = copyOverrides(form, DEFAULT_COPY);
    expect(copyFormFrom(saved, DEFAULT_COPY)).toEqual(form);
    const merged = mergeCopy(saved);
    expect(merged.messages.loan_pitch_in_window.body).toBe('Loans!');
    expect(merged.titles.NOT_NOW).toBe('Later');
    expect(merged.titles.POS).toBe(DEFAULT_COPY.titles.POS);
  });

  it('drops a reset message back to the default', () => {
    const form = copyFormFrom(
      {
        messages: { callback_ack: { body: 'x', variants: { IN_HOURS: 'y' } } },
      },
      DEFAULT_COPY
    );
    form.messages.callback_ack = blankMessageForm(
      DEFAULT_COPY.messages.callback_ack
    );
    expect(copyOverrides(form, DEFAULT_COPY)).toEqual({});
  });

  it('compares overrides for the dirty check', () => {
    const a = copyOverrides(blankForm(), DEFAULT_COPY);
    const form = blankForm();
    form.titles.QUOTE = 'Price me';
    expect(sameOverrides(a, copyOverrides(blankForm(), DEFAULT_COPY))).toBe(
      true
    );
    expect(sameOverrides(a, copyOverrides(form, DEFAULT_COPY))).toBe(false);
  });
});

describe('sessionMessages', () => {
  it('lists the SESSION messages with copy, with their payloads', () => {
    expect(sessionMessages(DEF, DEFAULT_COPY)).toEqual([
      {
        name: 'welcome_menu',
        list: false,
        buttons: ['POS', 'ACCOUNT', 'LOAN'],
      },
      {
        name: 'pos_pitch_in_window',
        list: true,
        buttons: ['QUOTE', 'COMPARE', 'ADVISOR', 'NOT_NOW', 'CALL_ME_BACK'],
      },
      {
        name: 'acct_pitch_in_window',
        list: false,
        buttons: ['CHECK_ELIGIBILITY', 'NOT_NOW', 'CALL_ME_BACK'],
      },
      {
        name: 'loan_pitch_in_window',
        list: false,
        buttons: ['CHECK_ELIGIBILITY', 'NOT_NOW', 'CALL_ME_BACK'],
      },
      { name: 'callback_ack', list: false, buttons: [] },
    ]);
  });
});

describe('title limits', () => {
  it('is 20 for a reply button, 24 for a list row, the tighter when both', () => {
    const limits = sessionTitleLimits(DEF);
    expect(limits.POS).toBe(20);
    expect(limits.QUOTE).toBe(24);
    expect(limits.COMPARE).toBe(24);
    // NOT_NOW and CALL_ME_BACK are list rows in the POS pitch and reply
    // buttons in the account and loan pitches.
    expect(limits.NOT_NOW).toBe(20);
    expect(limits.CALL_ME_BACK).toBe(20);
    expect(limits.PROCEED).toBeUndefined();
  });

  it('accepts every default title', () => {
    const form = blankForm();
    for (const [id, title] of Object.entries(DEFAULT_COPY.titles))
      form.titles[id] = title;
    for (const [name, m] of Object.entries(DEFAULT_COPY.messages))
      form.messages[name].buttonLabel = m.buttonLabel ?? '';
    expect(copyProblems(form, DEF)).toEqual([]);
  });

  it('refuses a reply-button title over 20 characters', () => {
    const form = blankForm();
    form.titles.POS = 'x'.repeat(20);
    expect(copyProblems(form, DEF)).toEqual([]);
    form.titles.POS = 'x'.repeat(21);
    expect(copyProblems(form, DEF)).toEqual([
      { kind: 'title', key: 'POS', length: 21, max: 20 },
    ]);
  });

  it('refuses a 25-character reply-button title', () => {
    const form = blankForm();
    form.titles.ACCOUNT = 'Open a business account!!';
    expect(form.titles.ACCOUNT).toHaveLength(25);
    expect(copyProblems(form, DEF)).toEqual([
      { kind: 'title', key: 'ACCOUNT', length: 25, max: 20 },
    ]);
  });

  it('allows a list row up to 24 characters', () => {
    const form = blankForm();
    form.titles.QUOTE = 'x'.repeat(24);
    expect(copyProblems(form, DEF)).toEqual([]);
    form.titles.QUOTE = 'x'.repeat(25);
    expect(copyProblems(form, DEF)).toEqual([
      { kind: 'title', key: 'QUOTE', length: 25, max: 24 },
    ]);
  });

  it('counts characters as WhatsApp does, ignoring outer spaces', () => {
    expect(textLength('  Not now  ')).toBe(7);
    expect(textLength('👍'.repeat(20))).toBe(20);
    const form = blankForm();
    form.titles.POS = `  ${'👍'.repeat(20)}  `;
    expect(copyProblems(form, DEF)).toEqual([]);
  });

  it('refuses a list button label over 20 characters', () => {
    const form = blankForm();
    form.messages.pos_pitch_in_window.buttonLabel = 'x'.repeat(21);
    expect(copyProblems(form, DEF)).toEqual([
      { kind: 'buttonLabel', key: 'pos_pitch_in_window', length: 21, max: 20 },
    ]);
  });
});

describe('parseTaamulDid', () => {
  it('stores an international number without spaces or dashes', () => {
    expect(parseTaamulDid('+971 4 123-4567')).toEqual({
      ok: true,
      value: '+97141234567',
    });
  });

  it('clears on a blank input', () => {
    expect(parseTaamulDid('')).toEqual({ ok: true, value: null });
    expect(parseTaamulDid('  ')).toEqual({ ok: true, value: null });
  });

  it('refuses anything that is not E.164', () => {
    for (const bad of ['04 123 4567', '+0123456789', '+12345', '+9714abc4567'])
      expect(parseTaamulDid(bad)).toEqual({ ok: false });
    expect(parseTaamulDid(`+1${'2'.repeat(15)}`)).toEqual({ ok: false });
  });
});
