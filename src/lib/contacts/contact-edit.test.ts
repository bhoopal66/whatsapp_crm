import { describe, expect, it } from 'vitest';

import type { RowWriter } from '@/lib/supabase/changed-rows';

import { contactPatch, saveContactEdit } from './contact-edit';

const loaded = {
  id: 'c1',
  name: 'Sara',
  phone: '+971 50 123 4567',
  email: 'sara@example.com',
  company: null,
};
const typed = {
  name: 'Sara',
  phone: '+971 50 123 4567',
  email: 'sara@example.com',
  company: '',
};
const PHONE = '+971 50 123 4567';

describe('contactPatch', () => {
  it('is empty when nothing was changed', () => {
    expect(contactPatch(loaded, typed, PHONE)).toEqual({});
  });

  it('sends only the field that was changed', () => {
    expect(contactPatch(loaded, { ...typed, name: 'Sara K' }, PHONE)).toEqual({
      name: 'Sara K',
    });
    expect(
      contactPatch(loaded, { ...typed, company: ' Acme ' }, PHONE)
    ).toEqual({ company: 'Acme' });
  });

  it('sends a cleared field as null', () => {
    expect(contactPatch(loaded, { ...typed, email: ' ' }, PHONE)).toEqual({
      email: null,
    });
  });

  it('sends the validated phone, and only when it was retyped', () => {
    expect(
      contactPatch(
        loaded,
        { ...typed, phone: '+971 55 000 1111' },
        '971550001111'
      )
    ).toEqual({ phone: '971550001111' });
    // Untouched, though saving would have trimmed it.
    expect(
      contactPatch(
        { ...loaded, phone: ' 97150 ' },
        { ...typed, phone: ' 97150 ' },
        '97150'
      )
    ).toEqual({});
  });

  it('leaves an untouched value alone, spaces and all', () => {
    expect(
      contactPatch(
        { ...loaded, name: 'Sara ' },
        { ...typed, name: 'Sara ' },
        PHONE
      )
    ).toEqual({});
    expect(
      contactPatch(
        { ...loaded, name: 'Sara ' },
        { ...typed, name: 'Sara' },
        PHONE
      )
    ).toEqual({ name: 'Sara' });
  });

  it('does not turn an empty string into null when nothing was typed', () => {
    expect(contactPatch({ ...loaded, company: '' }, typed, PHONE)).toEqual({});
  });
});

/** One contact row in a database; `visible` false is RLS filtering it. */
function fakeContacts(row: Record<string, unknown>, visible = true) {
  const writes: Record<string, unknown>[] = [];
  const sb = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          select: async () => {
            writes.push(patch);
            if (!visible) return { data: [], error: null };
            Object.assign(row, patch);
            return { data: [{ id: row.id }], error: null };
          },
        }),
      }),
    }),
  };
  return { sb: sb as unknown as RowWriter, writes };
}

describe('saveContactEdit', () => {
  it("keeps a colleague's change to another field", async () => {
    // A colleague changed the email after this form was loaded.
    const row: Record<string, unknown> = { ...loaded, email: 'new@x.com' };
    const { sb, writes } = fakeContacts(row);
    const res = await saveContactEdit(
      sb,
      loaded,
      { ...typed, name: 'Sara K' },
      PHONE
    );
    expect(res).toEqual({ kind: 'changed', ids: ['c1'] });
    expect(row).toMatchObject({ name: 'Sara K', email: 'new@x.com' });
    expect(Object.keys(writes[0]).sort()).toEqual(['name', 'updated_at']);
  });

  it('writes nothing when nothing was changed', async () => {
    const { sb, writes } = fakeContacts({ ...loaded });
    expect(await saveContactEdit(sb, loaded, typed, PHONE)).toEqual({
      kind: 'unchanged',
    });
    expect(writes).toEqual([]);
  });

  it('answers none when the contact can no longer be changed', async () => {
    const { sb } = fakeContacts({ ...loaded }, false);
    expect(
      await saveContactEdit(sb, loaded, { ...typed, name: 'X' }, PHONE)
    ).toEqual({ kind: 'none' });
  });
});
