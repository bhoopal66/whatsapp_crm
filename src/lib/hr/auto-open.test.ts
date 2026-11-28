import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { autoOpenRecruiterChat } from './auto-open';

beforeEach(() => {
  h.rpc.mockReset();
});

describe('autoOpenRecruiterChat', () => {
  it('calls hr_auto_open_recruiter with the conversation and the number', async () => {
    h.rpc.mockResolvedValue({ data: 'opened', error: null });
    await expect(
      autoOpenRecruiterChat({
        conversationId: 'conv-1',
        channelId: 'ch-1',
        text: 'Hi, my CV',
      })
    ).resolves.toBe('opened');
    expect(h.rpc).toHaveBeenCalledWith('hr_auto_open_recruiter', {
      p_conversation_id: 'conv-1',
      p_channel_id: 'ch-1',
    });
  });

  it('returns null and logs one line on an rpc error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    await expect(
      autoOpenRecruiterChat({
        conversationId: 'conv-1',
        channelId: 'ch-1',
        text: 'Hi, my CV',
      })
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('swallows a throw and returns null', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rpc.mockRejectedValue(new Error('fetch failed'));
    await expect(
      autoOpenRecruiterChat({
        conversationId: 'conv-1',
        channelId: 'ch-1',
        text: 'Hi, my CV',
      })
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  // Package 026d F8: a first message that is opt-out text must not open
  // the chat (opening queues cv_received), even when recording the
  // opt-out failed, so SQL is never asked.
  it.each([
    'STOP',
    'unsubscribe',
    'please stop messaging me',
    'إلغاء الاشتراك',
  ])('skips opt-out text %j without calling SQL', async (text) => {
    await expect(
      autoOpenRecruiterChat({
        conversationId: 'conv-1',
        channelId: 'ch-1',
        text,
      })
    ).resolves.toBe('opt_out');
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
