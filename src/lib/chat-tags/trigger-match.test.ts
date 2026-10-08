import { describe, expect, it } from 'vitest';

import type { ChatTagsPatch } from '@/types';

import { chatTagTriggerMatches } from './trigger-match';

const NONE: ChatTagsPatch = { chat_tag_id: null, chat_sub_tag_id: null };
const tags = (main: string | null, sub: string | null = null) => ({
  chat_tag_id: main,
  chat_sub_tag_id: sub,
});

const MAIN_ONLY = { chat_tag_id: 'interested' };
const MAIN_NULL_SUB = { chat_tag_id: 'interested', chat_sub_tag_id: null };
const PAIR = { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' };

describe('chatTagTriggerMatches — main tag only', () => {
  it('fires when the chat arrives at the main tag from no tag', () => {
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: NONE,
        current: tags('interested'),
      })
    ).toBe(true);
  });

  it('fires when the chat moves to the main tag from another one', () => {
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: tags('new'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(true);
  });

  it('treats an explicit null sub-tag in the config as main-only', () => {
    expect(
      chatTagTriggerMatches(MAIN_NULL_SUB, {
        previous: NONE,
        current: tags('interested', 'adcb'),
      })
    ).toBe(true);
  });

  it('never fires on re-saving the same tags', () => {
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: tags('interested'),
        current: tags('interested'),
      })
    ).toBe(false);
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: tags('interested', 'adcb'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(false);
  });

  it('does not fire when only the sub-tag under it changes', () => {
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: tags('interested'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(false);
  });

  it('does not fire for another main tag, or for clearing the tag', () => {
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: NONE,
        current: tags('not-interested'),
      })
    ).toBe(false);
    expect(
      chatTagTriggerMatches(MAIN_ONLY, {
        previous: tags('interested'),
        current: NONE,
      })
    ).toBe(false);
  });

  it('never fires for a config with no tag', () => {
    expect(
      chatTagTriggerMatches(
        { chat_tag_id: '' },
        { previous: tags('x'), current: NONE }
      )
    ).toBe(false);
  });
});

describe('chatTagTriggerMatches — main + sub-tag', () => {
  it('fires when the chat arrives at the pair from no tag', () => {
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: NONE,
        current: tags('interested', 'adcb'),
      })
    ).toBe(true);
  });

  it('fires when only the sub-tag changes to the configured one', () => {
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: tags('interested'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(true);
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: tags('interested', 'fab'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(true);
  });

  it('never fires on re-saving the same pair', () => {
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: tags('interested', 'adcb'),
        current: tags('interested', 'adcb'),
      })
    ).toBe(false);
  });

  it('does not fire when the main tag matches but the sub-tag does not', () => {
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: NONE,
        current: tags('interested'),
      })
    ).toBe(false);
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: tags('interested', 'adcb'),
        current: tags('interested', 'fab'),
      })
    ).toBe(false);
  });

  it('does not fire for another main tag', () => {
    expect(
      chatTagTriggerMatches(PAIR, {
        previous: NONE,
        current: tags('other', 'adcb'),
      })
    ).toBe(false);
  });
});

describe('chatTagTriggerMatches — one change, two triggers', () => {
  it('changing only the sub-tag under the configured main fires only a sub-tag trigger', () => {
    const ev = {
      previous: tags('interested', 'fab'),
      current: tags('interested', 'adcb'),
    };
    expect(chatTagTriggerMatches(MAIN_ONLY, ev)).toBe(false);
    expect(chatTagTriggerMatches(PAIR, ev)).toBe(true);
  });

  it('arriving at main + sub at once fires both kinds', () => {
    const ev = { previous: NONE, current: tags('interested', 'adcb') };
    expect(chatTagTriggerMatches(MAIN_ONLY, ev)).toBe(true);
    expect(chatTagTriggerMatches(PAIR, ev)).toBe(true);
  });
});
