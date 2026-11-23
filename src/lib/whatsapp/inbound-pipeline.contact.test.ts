import { beforeEach, describe, expect, it, vi } from 'vitest';

// findOrCreateContact: which contact an inbound message is filed under,
// and what it may change on it. Only the database is faked.

interface Row {
  id: string;
  phone: string;
  name: string | null;
}

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  /** One entry per contacts read: an error, or nothing for a good read. */
  readErrors: [] as unknown[],
  reads: 0,
  updateResult: (): { error: unknown } => ({ error: null }),
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) b[m] = () => b;
      b.like = async () => {
        const error = h.readErrors[h.reads++] ?? null;
        return { data: error ? null : h.rows, error };
      };
      b.update = (payload: Record<string, unknown>) => ({
        eq: async () => {
          h.updates.push(payload);
          return h.updateResult();
        },
      });
      b.insert = (payload: Record<string, unknown>) => {
        h.inserts.push(payload);
        return {
          select: () => ({
            single: async () => ({
              data: { id: 'new', ...payload },
              error: null,
            }),
          }),
        };
      };
      return b;
    },
  }),
}));

import { findOrCreateContact } from './inbound-pipeline';

const SENDER = '971501234567';
const inbound = (name: string, phone = SENDER) =>
  findOrCreateContact('acct', 'owner', phone, name);

beforeEach(() => {
  h.rows = [{ id: 'c1', phone: SENDER, name: 'Ahmed - ABC Trading LLC' }];
  h.readErrors = [];
  h.reads = 0;
  h.updateResult = () => ({ error: null });
  h.updates = [];
  h.inserts = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('findOrCreateContact — the name', () => {
  it('keeps the name staff gave the contact', async () => {
    const res = await inbound('ahmed');
    expect(res).toMatchObject({ contact: { id: 'c1' }, wasCreated: false });
    await inbound(SENDER);
    expect(h.updates).toEqual([]);
  });

  it('replaces the bare number with the sender name', async () => {
    h.rows[0].name = '+971 50 123 4567';
    await inbound('Ahmed');
    expect(h.updates).toEqual([expect.objectContaining({ name: 'Ahmed' })]);
  });

  it('does not lose the message when the rename fails', async () => {
    h.rows[0].name = null;
    h.updateResult = () => ({ error: { message: 'timeout' } });
    expect((await inbound('Ahmed'))?.contact.id).toBe('c1');
    h.updateResult = () => {
      throw new Error('network');
    };
    expect((await inbound('Ahmed'))?.contact.id).toBe('c1');
    expect(h.updates).toHaveLength(2);
  });
});

describe('findOrCreateContact — whose number it is', () => {
  it.each(['966501234567', '447501234567'])(
    'gives %s, a stranger with the same last 8 digits, a contact of its own',
    async (phone) => {
      const res = await inbound('Stranger', phone);
      expect(res).toMatchObject({ contact: { id: 'new' }, wasCreated: true });
      expect(h.inserts).toEqual([
        expect.objectContaining({ phone, name: 'Stranger' }),
      ]);
    }
  );
});

describe('findOrCreateContact — a failed lookup', () => {
  it('retries once and creates nothing', async () => {
    h.readErrors = [{ code: '57014' }];
    const res = await inbound('Ahmed');
    expect(res).toMatchObject({ contact: { id: 'c1' }, wasCreated: false });
    expect(h.reads).toBe(2);
    expect(h.inserts).toEqual([]);
  });

  it('throws when it keeps failing, and still creates nothing', async () => {
    h.readErrors = [{ code: '57014' }, { code: '57014' }];
    await expect(inbound('Ahmed')).rejects.toThrow('Contact lookup failed');
    expect(h.inserts).toEqual([]);
  });
});
