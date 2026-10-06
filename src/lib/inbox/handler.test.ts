import { describe, it, expect } from 'vitest';

import { resolveConversationHandler } from './handler';

const conv = (assigned?: string | null, owner = 'owner-1') => ({
  user_id: owner,
  assigned_agent_id: assigned ?? null,
});

const agentMsg = (senderId: string | null) =>
  ({ sender_type: 'agent', sender_id: senderId ?? undefined }) as const;
const botMsg = () => ({ sender_type: 'bot', sender_id: undefined }) as const;
const customerMsg = () =>
  ({ sender_type: 'customer', sender_id: undefined }) as const;

describe('resolveConversationHandler', () => {
  it('prefers the assignee over everything else', () => {
    expect(
      resolveConversationHandler(conv('agent-a'), [agentMsg('agent-b')])
    ).toEqual({ userId: 'agent-a', kind: 'assigned' });
  });

  it('falls back to the last human who replied', () => {
    expect(
      resolveConversationHandler(conv(null), [
        customerMsg(),
        agentMsg('agent-a'),
        customerMsg(),
        agentMsg('agent-b'),
        customerMsg(),
      ])
    ).toEqual({ userId: 'agent-b', kind: 'replying' });
  });

  it('never names the bot as the handler', () => {
    // Flows, automations and AI auto-reply all send as 'bot'. A thread
    // only a bot has answered is still nobody's.
    expect(
      resolveConversationHandler(conv(null), [customerMsg(), botMsg()])
    ).toEqual({ userId: 'owner-1', kind: 'owner' });
  });

  it('skips agent rows written before sends recorded a sender', () => {
    expect(
      resolveConversationHandler(conv(null), [
        agentMsg('agent-a'),
        agentMsg(null),
      ])
    ).toEqual({ userId: 'agent-a', kind: 'replying' });
  });

  it('falls back to the row owner when nobody has replied', () => {
    expect(resolveConversationHandler(conv(null), [customerMsg()])).toEqual({
      userId: 'owner-1',
      kind: 'owner',
    });
  });

  it('returns null when there is nobody to name', () => {
    expect(
      resolveConversationHandler({ user_id: '', assigned_agent_id: null }, [])
    ).toBeNull();
  });
});
