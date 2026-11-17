import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NEW_CHAT_NOTICE,
  marketingNumberName,
  newChatNoticeWording,
  offersMarketingSwitch,
  parseNewChatNotice,
  parseNoticeInput,
  shouldShowNewChatNotice,
  type NewChatNotice,
} from './new-chat-notice';

const ID = '3f2c1a9e-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const notice = (o: Partial<NewChatNotice> = {}): NewChatNotice => ({
  ...DEFAULT_NEW_CHAT_NOTICE,
  ...o,
});

describe('parseNewChatNotice', () => {
  it('reads the RPC shape', () => {
    expect(
      parseNewChatNotice({
        enabled: false,
        channel_id: ID,
        channel_label: 'Marketing',
        channel_phone: '+971500000000',
        channel_provider: 'openwa',
        text: 'Hi',
      })
    ).toEqual({
      enabled: false,
      channelId: ID,
      channelLabel: 'Marketing',
      channelPhone: '+971500000000',
      provider: 'openwa',
      text: 'Hi',
    });
  });
  it('defaults on anything malformed', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}]) {
      expect(parseNewChatNotice(bad)).toEqual(DEFAULT_NEW_CHAT_NOTICE);
    }
    expect(
      parseNewChatNotice({ enabled: 'no', channel_id: 5, text: '  ' })
    ).toEqual(DEFAULT_NEW_CHAT_NOTICE);
  });
  it('keeps a guest answer off', () => {
    expect(parseNewChatNotice({ enabled: false }).enabled).toBe(false);
  });
});

describe('parseNoticeInput', () => {
  it('trims text and turns empty into null', () => {
    expect(
      parseNoticeInput({ enabled: true, channelId: ID, text: '  hi  ' })
    ).toEqual({
      ok: true,
      value: { enabled: true, channelId: ID, text: 'hi' },
    });
    expect(
      parseNoticeInput({ enabled: true, channelId: null, text: '   ' })
    ).toEqual({
      ok: true,
      value: { enabled: true, channelId: null, text: null },
    });
  });
  it('rejects bad shapes and over-long text', () => {
    expect(parseNoticeInput(null).ok).toBe(false);
    expect(parseNoticeInput({ channelId: null, text: null }).ok).toBe(false);
    expect(
      parseNoticeInput({ enabled: true, channelId: 'nope', text: null }).ok
    ).toBe(false);
    expect(
      parseNoticeInput({
        enabled: true,
        channelId: null,
        text: 'x'.repeat(301),
      }).ok
    ).toBe(false);
    expect(
      parseNoticeInput({
        enabled: true,
        channelId: null,
        text: 'x'.repeat(300),
      }).ok
    ).toBe(true);
  });
});

describe('shouldShowNewChatNotice', () => {
  const base = {
    notice: notice({ channelId: ID }),
    wouldStartChat: true,
    isPersonalChat: false,
    sendingChannelId: 'other',
  };
  it('shows for a new chat from another number', () => {
    expect(shouldShowNewChatNotice(base)).toBe(true);
  });
  it('hides when off, not a new chat, or personal', () => {
    expect(
      shouldShowNewChatNotice({ ...base, notice: notice({ enabled: false }) })
    ).toBe(false);
    expect(shouldShowNewChatNotice({ ...base, wouldStartChat: false })).toBe(
      false
    );
    expect(shouldShowNewChatNotice({ ...base, isPersonalChat: true })).toBe(
      false
    );
  });
  it('hides when already on the marketing number', () => {
    expect(shouldShowNewChatNotice({ ...base, sendingChannelId: ID })).toBe(
      false
    );
  });
  it('shows with no marketing number named, whatever the sender', () => {
    expect(
      shouldShowNewChatNotice({
        ...base,
        notice: notice(),
        sendingChannelId: null,
      })
    ).toBe(true);
  });
});

describe('marketingNumberName', () => {
  it('prefers label, then phone, else null', () => {
    expect(
      marketingNumberName(notice({ channelLabel: 'M', channelPhone: '1' }))
    ).toBe('M');
    expect(marketingNumberName(notice({ channelPhone: '1' }))).toBe('1');
    expect(marketingNumberName(notice())).toBeNull();
  });
});

describe('newChatNoticeWording', () => {
  it('uses the admin text verbatim', () => {
    expect(
      newChatNoticeWording(
        notice({ text: 'Use Marketing', channelId: ID, channelLabel: 'M' })
      )
    ).toEqual({ kind: 'custom', text: 'Use Marketing' });
  });
  it('names the marketing number: label, else phone', () => {
    expect(
      newChatNoticeWording(notice({ channelId: ID, channelLabel: 'Mkt' }))
    ).toEqual({ kind: 'named', name: 'Mkt' });
    expect(
      newChatNoticeWording(notice({ channelId: ID, channelPhone: '+9715' }))
    ).toEqual({ kind: 'named', name: '+9715' });
  });
  it('falls back to the generic wording', () => {
    expect(newChatNoticeWording(notice())).toEqual({ kind: 'default' });
    expect(newChatNoticeWording(notice({ channelId: ID }))).toEqual({
      kind: 'default',
    });
  });
});

describe('offersMarketingSwitch', () => {
  const set = notice({ channelId: ID });
  it('offers it when the caller may use the marketing number', () => {
    expect(
      offersMarketingSwitch({ notice: set, usableIds: [ID], locked: false })
    ).toBe(true);
  });
  it('not without a marketing number', () => {
    expect(
      offersMarketingSwitch({
        notice: notice(),
        usableIds: [ID],
        locked: false,
      })
    ).toBe(false);
  });
  it('not when the caller may not send from it, or before numbers load', () => {
    expect(
      offersMarketingSwitch({ notice: set, usableIds: ['x'], locked: false })
    ).toBe(false);
    expect(
      offersMarketingSwitch({ notice: set, usableIds: null, locked: false })
    ).toBe(false);
  });
  it('not on a chat locked to its own number', () => {
    expect(
      offersMarketingSwitch({ notice: set, usableIds: [ID], locked: true })
    ).toBe(false);
  });
});
