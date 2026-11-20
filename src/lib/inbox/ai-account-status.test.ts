import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_STATUS_OFF,
  fetchAiAccountStatus,
  parseAiAccountStatus,
  resetAiAccountStatusForTests,
} from '@/lib/inbox/ai-account-status';

const live = {
  configured: true,
  is_active: true,
  auto_reply_enabled: true,
  auto_resume_minutes: 30,
};

function ok(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => resetAiAccountStatusForTests());

describe('parseAiAccountStatus', () => {
  it('is live only with every switch on', () => {
    expect(parseAiAccountStatus(live)).toEqual({
      autoReplyOn: true,
      autoResumeMinutes: 30,
    });
    expect(
      parseAiAccountStatus({ ...live, auto_reply_enabled: false }).autoReplyOn
    ).toBe(false);
    expect(parseAiAccountStatus(null)).toEqual(AI_STATUS_OFF);
  });
});

describe('fetchAiAccountStatus', () => {
  it('makes one request for a warm-up and a banner asking together', async () => {
    const f = vi.fn(() => ok(live));
    const [a, b] = await Promise.all([
      fetchAiAccountStatus('acc', f),
      fetchAiAccountStatus('acc', f),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    await fetchAiAccountStatus('acc', f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps accounts apart', async () => {
    const f = vi.fn(() => ok(live));
    await fetchAiAccountStatus('a1', f);
    await fetchAiAccountStatus('a2', f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    expect(await fetchAiAccountStatus('acc', f)).toEqual(AI_STATUS_OFF);
    const g = vi.fn(() => ok(live));
    expect((await fetchAiAccountStatus('acc', g)).autoReplyOn).toBe(true);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('caches a refusal: a restricted department is not asked again', async () => {
    const f = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'no access' }), { status: 403 })
      )
    );
    expect(await fetchAiAccountStatus('acc', f)).toEqual(AI_STATUS_OFF);
    expect(await fetchAiAccountStatus('acc', f)).toEqual(AI_STATUS_OFF);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
