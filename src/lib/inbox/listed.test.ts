import { describe, expect, it } from 'vitest';

import { isListedInInbox } from './listed';

const base = {
  campaign_broadcast_id: null,
  human_engaged_at: null,
  assigned_agent_id: null,
  ai_autoreply_disabled: false,
  ai_reply_count: 0,
  chat_tag_id: null,
  user_id: 'other',
  personal_owner_id: null,
  inbox_department: null,
};

describe('isListedInInbox', () => {
  it('lists a plain company chat', () => {
    expect(isListedInInbox(base, true, 'me')).toBe(true);
  });

  it('leaves out a Campaign inbox chat only while the AI is live', () => {
    const campaign = {
      ...base,
      campaign_broadcast_id: 'b',
      ai_reply_count: 2,
    };
    expect(isListedInInbox(campaign, true, 'me')).toBe(false);
    expect(isListedInInbox(campaign, false, 'me')).toBe(true);
  });

  it("leaves out someone else's personal chat, except in the wide view", () => {
    const personal = { ...base, personal_owner_id: 'mate' };
    expect(isListedInInbox(personal, false, 'me')).toBe(false);
    expect(isListedInInbox(personal, false, 'me', true)).toBe(true);
    expect(
      isListedInInbox({ ...base, personal_owner_id: 'me' }, false, 'me')
    ).toBe(true);
  });

  it("leaves out another department's chat unless it is the viewer's own or department", () => {
    const hr = { ...base, inbox_department: 'hr' as const };
    expect(isListedInInbox(hr, false, 'me')).toBe(false);
    expect(isListedInInbox(hr, false, 'me', false, 'hr')).toBe(true);
    expect(isListedInInbox({ ...hr, user_id: 'me' }, false, 'me')).toBe(true);
  });
});
