import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

// ------------------------------------------------------------
// Chainable Supabase stub, scripted per table. Terminal methods
// (like/maybeSingle/single) resolve to configured data; the builder
// itself is thenable so an awaited `update().eq()` resolves cleanly.
// ------------------------------------------------------------
type ContactRow = { id: string; phone: string; name?: string | null };

interface Script {
  config?: { user_id: string } | null; // whatsapp_config.maybeSingle
  contactCandidates?: ContactRow[]; // contacts .like (same every call)
  /** Per-call `.like` results — overrides contactCandidates. Lets a
   *  test simulate "miss, then hit" for the unique-race path. */
  contactCandidatesByCall?: ContactRow[][];
  insertedContactId?: string; // contacts insert -> single
  insertContactError?: { code?: string } | null;
  /** Conversation lookup result (oldest-first `.order().limit(1)`).
   *  A single row or null; wrapped into a one-element array internally. */
  existingConversation?: { id: string } | null; // conversations select.limit(1)
  /** Per-call conversation lookup results — overrides existingConversation.
   *  Lets a test simulate "miss, then hit" for the unique-race path. */
  existingConversationByCall?: ({ id: string } | null)[];
  insertedConversationId?: string; // conversations insert -> single
  insertConversationError?: { code?: string } | null;
  /** Records the table of every `.update()` call, for assertions. */
  updatedTables?: string[];
  /** Records every `.insert()` payload with its table, for assertions. */
  inserted?: { table: string; row: Record<string, unknown> }[];
  /** Records every `.like()` pattern (the contact lookup's suffix). */
  likePatterns?: string[];
}

function makeDb(script: Script): SupabaseClient {
  let table = '';
  let mode: 'select' | 'insert' | 'update' = 'select';
  let likeCalls = 0;
  let convLookupCalls = 0;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (row: Record<string, unknown>) => {
      mode = 'insert';
      script.inserted?.push({ table, row });
      return builder;
    },
    update: () => {
      mode = 'update';
      script.updatedTables?.push(table);
      return builder;
    },
    eq: () => builder,
    order: () => builder,
    limit: () => {
      // whatsapp_config chains .limit(1).maybeSingle() — an account can
      // hold two channels since migration 046, so the precheck takes
      // one rather than asserting there is exactly one.
      if (table === 'whatsapp_config') return builder;
      // Only the conversation lookup terminates on `.limit(1)`.
      if (table === 'conversations' && mode === 'select') {
        const row = script.existingConversationByCall
          ? (script.existingConversationByCall[convLookupCalls] ?? null)
          : (script.existingConversation ?? null);
        convLookupCalls++;
        return Promise.resolve({ data: row ? [row] : [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    like: (_column: string, pattern: string) => {
      script.likePatterns?.push(pattern);
      const data = script.contactCandidatesByCall
        ? (script.contactCandidatesByCall[likeCalls] ?? [])
        : (script.contactCandidates ?? []);
      likeCalls++;
      return Promise.resolve({ data, error: null });
    },
    maybeSingle: () => {
      if (table === 'whatsapp_config')
        return Promise.resolve({ data: script.config ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        if (script.insertContactError)
          return Promise.resolve({
            data: null,
            error: script.insertContactError,
          });
        return Promise.resolve({
          data: { id: script.insertedContactId },
          error: null,
        });
      }
      if (table === 'conversations' && mode === 'insert') {
        if (script.insertConversationError)
          return Promise.resolve({
            data: null,
            error: script.insertConversationError,
          });
        return Promise.resolve({
          data: { id: script.insertedConversationId },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    // Thenable: `await db.from().update().eq()` lands here.
    then: (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null }),
  };

  return {
    from: (t: string) => {
      table = t;
      mode = 'select';
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    const db = {
      from() {
        throw new Error('should not query');
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveConversationByPhone(db, 'acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('fails with whatsapp_not_configured when no config owner exists', async () => {
    const db = makeDb({ config: null });
    await resolveConversationByPhone(db, 'acct', '+14155550123').catch(
      (e: SendMessageError) => {
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
      }
    );
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('returns the existing contact + conversation without creating', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv1' },
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+1 (415) 555-0123'
    );
    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      contactCreated: false,
      conversationCreated: false,
    });
  });

  it('creates contact + conversation when none exist', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [],
      insertedContactId: 'c2',
      existingConversation: null,
      insertedConversationId: 'cv2',
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550199',
      'Jane'
    );
    expect(res).toEqual({
      conversationId: 'cv2',
      contactId: 'c2',
      contactCreated: true,
      conversationCreated: true,
    });
  });

  it('re-resolves an existing contact when the insert loses a unique race', async () => {
    // First lookup misses (→ we attempt an insert), the insert hits a
    // 23505 unique violation, and the post-race re-lookup now returns
    // the row a concurrent writer created.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidatesByCall: [[], [{ id: 'c-raced', phone: '14155550123' }]],
      insertContactError: { code: '23505' },
      existingConversation: { id: 'cv-raced' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res.contactId).toBe('c-raced');
    expect(res.contactCreated).toBe(false);
    expect(res.conversationId).toBe('cv-raced');
  });

  it('re-resolves the conversation when the insert loses a unique race', async () => {
    // Existing contact, conversation lookup misses first (→ attempt an
    // insert), the insert hits a 23505 from a concurrent create, and the
    // post-race re-lookup returns the winning conversation — no duplicate
    // conversation is created (issue #363).
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversationByCall: [null, { id: 'cv-raced' }],
      insertConversationError: { code: '23505' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res).toEqual({
      conversationId: 'cv-raced',
      contactId: 'c1',
      contactCreated: false,
      conversationCreated: false,
    });
  });

  it('renames an existing contact by default', async () => {
    const updatedTables: string[] = [];
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123', name: 'Old' }],
      existingConversation: { id: 'cv1' },
      updatedTables,
    });
    await resolveConversationByPhone(db, 'acct', '+14155550123', 'New');
    expect(updatedTables).toContain('contacts');
  });

  it('leaves an existing contact name alone when renameExisting is false', async () => {
    // Compass notifications: the ERP's spelling must not overwrite a
    // name an agent curated on a chat they already work.
    const updatedTables: string[] = [];
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123', name: 'Curated' }],
      existingConversation: { id: 'cv1' },
      updatedTables,
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      'ERP NAME',
      { renameExisting: false }
    );
    expect(updatedTables).toEqual([]);
    expect(res.conversationCreated).toBe(false);
  });
});

describe('resolveConversationByPhone — the contact rule for a new number', () => {
  const noContactYet = (script: Partial<Script> = {}): Script => ({
    config: { user_id: 'owner-1' },
    contactCandidates: [],
    insertedContactId: 'c-new',
    existingConversation: null,
    insertedConversationId: 'cv-new',
    ...script,
  });

  it.each([
    ['504555843', 'too_short'], // the live local UAE mobile
    ['+971 50 123 456', 'invalid_uae'],
    ['98765 43210', 'invalid_number'], // Indian mobile without +91
  ])(
    'refuses to create a contact for %s (%s) and creates nothing',
    async (to) => {
      const inserted: Script['inserted'] = [];
      const db = makeDb(noContactYet({ inserted }));
      const err = await resolveConversationByPhone(db, 'acct', to).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SendMessageError);
      expect(err).toMatchObject({ code: 'bad_request', status: 400 });
      expect((err as Error).message).toMatch(/^'to' "/);
      expect((err as Error).message).toContain('+971 50 123 4567');
      expect(inserted).toEqual([]);
    }
  );

  it('still finds an existing contact saved in a shape the rule refuses', async () => {
    // A legacy row typed as "504555843" keeps working for integrations
    // that address it the same way; only creating one is refused.
    const inserted: Script['inserted'] = [];
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c-legacy', phone: '504555843' }],
      existingConversation: { id: 'cv-legacy' },
      inserted,
    });
    const res = await resolveConversationByPhone(db, 'acct', '504555843');
    expect(res).toMatchObject({
      contactId: 'c-legacy',
      conversationId: 'cv-legacy',
      contactCreated: false,
    });
    expect(inserted).toEqual([]);
  });

  it('stores a new contact normalized, trunk 0 removed', async () => {
    const inserted: Script['inserted'] = [];
    const db = makeDb(noContactYet({ inserted }));
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+971 050 123 4567'
    );
    expect(res.contactCreated).toBe(true);
    expect(inserted.find((i) => i.table === 'contacts')?.row).toMatchObject({
      phone: '971501234567',
      name: '971501234567',
    });
  });

  it('keeps the given name and stores the normalized number', async () => {
    const inserted: Script['inserted'] = [];
    const db = makeDb(noContactYet({ inserted }));
    await resolveConversationByPhone(db, 'acct', '+44 (0)7700 900123', 'Jo');
    expect(inserted.find((i) => i.table === 'contacts')?.row).toMatchObject({
      phone: '447700900123',
      name: 'Jo',
    });
  });

  it('re-resolves a lost insert race by the normalized number', async () => {
    // "+961 03 123 456": the typed digits end 03123456, the stored
    // number 9613123456 ends 13123456 — the re-lookup must use the
    // number that was actually inserted.
    const inserted: Script['inserted'] = [];
    const likePatterns: string[] = [];
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidatesByCall: [[], [{ id: 'c-raced', phone: '9613123456' }]],
      insertContactError: { code: '23505' },
      existingConversation: { id: 'cv-raced' },
      inserted,
      likePatterns,
    });
    const res = await resolveConversationByPhone(db, 'acct', '+961 03 123 456');
    expect(inserted[0]).toMatchObject({
      table: 'contacts',
      row: { phone: '9613123456' },
    });
    expect(likePatterns).toEqual(['%13123456', '%13123456']);
    expect(res).toMatchObject({ contactId: 'c-raced', contactCreated: false });
  });

  it('never matches an unrelated contact that shares the typed tail', async () => {
    // "+961 03 123 456" types …03123456; an older UAE contact
    // 971503123456 ends the same. Looking up the typed digits picked
    // it, and the Lebanese customer's message went to that person.
    const inserted: Script['inserted'] = [];
    const likePatterns: string[] = [];
    const db = makeDb(
      noContactYet({
        contactCandidates: [{ id: 'c-uae', phone: '971503123456' }],
        inserted,
        likePatterns,
      })
    );
    const res = await resolveConversationByPhone(db, 'acct', '+961 03 123 456');
    expect(likePatterns).toEqual(['%13123456']);
    expect(res).toMatchObject({ contactId: 'c-new', contactCreated: true });
    expect(inserted.find((i) => i.table === 'contacts')?.row).toMatchObject({
      phone: '9613123456',
    });
  });

  it('finds the contact by the normalized number when the typed one has a trunk 0', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [
        { id: 'c-uae', phone: '971503123456' },
        { id: 'c-lb', phone: '9613123456' },
      ],
      existingConversation: { id: 'cv-lb' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+961 03 123 456');
    expect(res).toMatchObject({ contactId: 'c-lb', contactCreated: false });
  });

  it.each([['919876543210.0'], ['+44 77OO 900123'], ['9.71505E+11']])(
    'refuses %s before any lookup: its digits are not the number',
    async (to) => {
      const db = {
        from() {
          throw new Error('should not query');
        },
      } as unknown as SupabaseClient;
      await expect(
        resolveConversationByPhone(db, 'acct', to)
      ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
  );
});
