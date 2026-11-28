import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    requireRole: h.requireRole,
    toErrorResponse: actual.toErrorResponse,
    ForbiddenError: actual.ForbiddenError,
  };
});
vi.mock('@/lib/storage/chat-media-sign', () => ({
  signChatMediaPath: h.sign,
  VIEWER_LINK_TTL_SECONDS: 300,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { mediaView: {} },
}));

import { ForbiddenError } from '@/lib/auth/account';
import { GET } from './route';

const get = (...path: string[]) =>
  GET(new Request('http://x'), { params: Promise.resolve({ path }) });
const getAs = (query: string, ...path: string[]) =>
  GET(new Request(`http://x/?${query}`), { params: Promise.resolve({ path }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue({ accountId: 'a1', userId: 'u1' });
  h.sign.mockResolvedValue(
    'https://crm.example.com/storage/v1/object/sign/chat-media/x?token=t'
  );
});

describe('GET /api/media/chat/[...path]', () => {
  it('redirects staff of the owning workspace to a short signed link', async () => {
    const res = await get('account-a1', 'inbound', 'wamid-1.jpg');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('token=t');
    expect(res.headers.get('cache-control')).toBe('private, max-age=240');
    expect(h.sign).toHaveBeenCalledWith(
      'account-a1/inbound/wamid-1.jpg',
      300,
      undefined,
      undefined
    );
    expect(h.requireRole).toHaveBeenCalledWith('viewer');
  });

  it('refuses another workspace’s file and unsafe paths, without signing', async () => {
    for (const p of [
      ['account-b2', 'inbound', 'x.jpg'],
      ['account-a1', '..', 'account-b2', 'x.jpg'],
      ['account-a10', 'x.jpg'],
      [],
    ]) {
      expect((await get(...p)).status, p.join('/')).toBe(404);
    }
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing object, and refuses a guest or a stranger', async () => {
    h.sign.mockResolvedValue(null);
    expect((await get('account-a1', 'x.jpg')).status).toBe(404);
    h.requireRole.mockRejectedValue(new ForbiddenError('no'));
    expect((await get('account-a1', 'x.jpg')).status).toBe(403);
  });

  it('passes a download name on, and drops an unsafe one', async () => {
    await getAs('download=Trade%20licence.pdf', 'account-a1', 'x.pdf');
    expect(h.sign).toHaveBeenLastCalledWith(
      'account-a1/x.pdf',
      300,
      undefined,
      'Trade licence.pdf'
    );
    await getAs('download=a%22b', 'account-a1', 'x.pdf');
    expect(h.sign).toHaveBeenLastCalledWith(
      'account-a1/x.pdf',
      300,
      undefined,
      undefined
    );
  });
});
