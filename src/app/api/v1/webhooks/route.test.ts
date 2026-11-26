import { beforeEach, describe, expect, it, vi } from 'vitest';

// A webhook endpoint belongs to the key that set it up (migration 315),
// and message events need `messages:read` besides `webhooks:manage`.

const h = vi.hoisted(() => ({
  scopes: [] as string[],
  current: null as { events: string[] } | null,
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    accountId: 'acct-1',
    keyId: 'key-1',
    createdBy: 'user-1',
    scopes: h.scopes,
    supabase: {
      from: () => {
        const row = { id: 'wh-1', url: 'https://x.test/', events: [] };
        let read = true;
        const q = {
          insert: (v: unknown) => {
            read = false;
            h.insert(v);
            return q;
          },
          update: (v: unknown) => {
            read = false;
            h.update(v);
            return q;
          },
          select: () => q,
          eq: () => q,
          single: async () => ({ data: row, error: null }),
          maybeSingle: async () => ({
            data: read ? h.current : row,
            error: null,
          }),
        };
        return q;
      },
    },
  }),
}));

import { POST } from './route';
import { PATCH } from './[id]/route';

const req = (body: unknown) =>
  new Request('https://crm.test/api/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const patch = (body: unknown) =>
  PATCH(req(body), { params: Promise.resolve({ id: 'wh-1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.scopes = ['webhooks:manage'];
  h.current = { events: ['contact.opted_out'] };
});

describe('POST /api/v1/webhooks', () => {
  it.each(['message.received', 'message.status_updated'])(
    'refuses %s without messages:read',
    async (event) => {
      const res = await POST(req({ url: 'https://x.test/', events: [event] }));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
      expect(h.insert).not.toHaveBeenCalled();
    }
  );

  it('takes message events with messages:read, and records the key', async () => {
    h.scopes = ['webhooks:manage', 'messages:read'];
    const res = await POST(
      req({ url: 'https://x.test/', events: ['message.received'] })
    );
    expect(res.status).toBe(201);
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acct-1', api_key_id: 'key-1' })
    );
  });

  it('asks for no more than webhooks:manage for other events', async () => {
    const res = await POST(
      req({ url: 'https://x.test/', events: ['contact.opted_out'] })
    );
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/v1/webhooks/{id}', () => {
  it.each([
    { url: 'https://elsewhere.test/' },
    { is_active: true },
    { events: ['message.received'] },
  ])('refuses %j on a message endpoint without messages:read', async (body) => {
    h.current = { events: ['message.received'] };
    expect((await patch(body)).status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('makes a changed endpoint the calling key’s', async () => {
    expect((await patch({ url: 'https://elsewhere.test/' })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ api_key_id: 'key-1' })
    );
  });

  it('lets any webhooks:manage key switch one off, and leaves its key', async () => {
    h.current = { events: ['message.received'] };
    expect((await patch({ is_active: false })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({ is_active: false });
  });
});
