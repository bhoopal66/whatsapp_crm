import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string) => k;
  return { useTranslations: () => t };
});
const auth = vi.hoisted(() => ({ accountId: 'acc-1' }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    accountId: auth.accountId,
    accountRole: 'admin',
    profileLoading: false,
  }),
}));
vi.mock('@/lib/account/members', () => ({
  fetchAccountMembers: async () => [],
  staffOnly: (x: unknown) => x,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { render, resetHooks, settle } from '@/test/hook-renderer';
import { useAiConfigForm } from './use-ai-config-form';

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const STORED = {
  configured: true,
  has_key: true,
  provider: 'openai',
  model: 'gpt-x',
  system_prompt: 'The real prompt',
  auto_reply_enabled: true,
};

/** Answers for GET /api/ai/config, in turn; the last one repeats. */
let answers: (() => Promise<unknown>)[] = [];
let posts: unknown[] = [];

beforeEach(() => {
  resetHooks();
  auth.accountId = 'acc-1';
  answers = [];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/ai/config') return json({});
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ success: true });
      }
      return (answers.length > 1 ? answers.shift()! : answers[0])();
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const form = () => render(useAiConfigForm);

describe('an AI configuration that could not be read', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['offline', () => Promise.reject(new Error('offline'))],
    ['a server error', async () => json({ error: 'x' }, 500)],
    ['an answer that says nothing', async () => json({})],
  ])('%s: an error, and Save sends nothing', async (_name, answer) => {
    answers = [answer];
    form();
    await settle();
    expect(form().loadError).toBe(true);
    expect(form().loading).toBe(false);
    // Typing a key used to post the whole empty form over the row.
    form().set('apiKey', 'sk-new');
    form().set('keyEdited', true);
    await form().save();
    expect(posts).toEqual([]);
  });

  it('Retry loads what is stored, and it can be saved', async () => {
    answers = [
      () => Promise.reject(new Error('offline')),
      async () => json(STORED),
    ];
    form();
    await settle();
    form().retry();
    await settle();
    expect(form().loadError).toBe(false);
    expect(form().configured).toBe(true);
    expect(form().values.systemPrompt).toBe('The real prompt');
    form().set('strictGrounding', true);
    await form().save();
    expect(posts).toMatchObject([
      { system_prompt: 'The real prompt', strict_grounding: true },
    ]);
  });
});

it('a workspace that is not set up never keeps the last one’s form', async () => {
  answers = [async () => json(STORED), async () => json({ configured: false })];
  form();
  await settle();
  auth.accountId = 'acc-2';
  form();
  await settle();
  expect(form().configured).toBe(false);
  expect(form().hasStoredKey).toBe(false);
  expect(form().values.systemPrompt).toBe('');
});
