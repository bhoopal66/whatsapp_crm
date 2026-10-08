import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('./engine', () => ({ runAutomationsForTrigger: mocks.run }));

import { dispatchChatTagSet } from './chat-tag-dispatch';

const base = {
  accountId: 'acc-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
};

beforeEach(() => {
  mocks.run.mockReset();
  mocks.run.mockResolvedValue(undefined);
});

describe('dispatchChatTagSet', () => {
  it('dispatches nothing when the tags did not change', async () => {
    await dispatchChatTagSet({
      ...base,
      previous: { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
      saved: { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
    });
    await dispatchChatTagSet({
      ...base,
      previous: { chat_tag_id: null, chat_sub_tag_id: null },
      saved: { chat_tag_id: null, chat_sub_tag_id: null },
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('dispatches chat_tag_set with the before and after tags', async () => {
    await dispatchChatTagSet({
      ...base,
      previous: { chat_tag_id: 'new', chat_sub_tag_id: null },
      saved: { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith({
      accountId: 'acc-1',
      triggerType: 'chat_tag_set',
      contactId: 'contact-1',
      context: {
        conversation_id: 'conv-1',
        chat_tag_id: 'interested',
        chat_sub_tag_id: 'adcb',
        previous_chat_tag_id: 'new',
        previous_chat_sub_tag_id: null,
        vars: { _chat_tag_chain_depth: 1 },
      },
    });
  });

  it('dispatches when only the sub-tag changed, carrying the chain depth on', async () => {
    await dispatchChatTagSet({
      ...base,
      previous: { chat_tag_id: 'interested', chat_sub_tag_id: 'fab' },
      saved: { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
      depth: 2,
    });
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          chat_sub_tag_id: 'adcb',
          previous_chat_sub_tag_id: 'fab',
          vars: { _chat_tag_chain_depth: 3 },
        }),
      })
    );
  });

  it('awaits the engine before resolving', async () => {
    let finished = false;
    mocks.run.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished = true;
    });
    await dispatchChatTagSet({
      ...base,
      previous: { chat_tag_id: null, chat_sub_tag_id: null },
      saved: { chat_tag_id: 'interested', chat_sub_tag_id: null },
    });
    expect(finished).toBe(true);
  });
});
