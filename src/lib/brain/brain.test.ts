/**
 * 022a second brain, pure parts (ported from the package's
 * brain.unit.test.ts): chunking, redaction before storage (phones, 15-digit
 * IDs), the HashingEmbedder (determinism, normalisation, ranking sanity),
 * ingest with in-memory ports (what reaches the store is redacted), search
 * scoring / audit hashing, and the no-vault / no-document-intake import scan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CHUNK_MAX, chunkText } from './chunk';
import { cosine, HashingEmbedder } from './embed';
import { ingestMessage, ingestNote, ingestRemember } from './ingest';
import type { BrainCandidate } from './ports';
import { brainRedact } from './redact';
import { searchBrain, sha256Hex, snippet, SNIPPET_MAX } from './search';
import { MemPorts, memDeps as deps } from './test-fakes';

const PHONE_RE = /\+?\d[\d\s-]{7,}\d/;

describe('022a chunkText', () => {
  it('keeps short text as one chunk and returns nothing for blank input', () => {
    expect(chunkText('Hello there. How are you?')).toEqual([
      'Hello there. How are you?',
    ]);
    expect(chunkText('   \n  ')).toEqual([]);
  });
  it('splits on sentence boundaries with every chunk <= 800 chars', () => {
    const s =
      'The customer sent the trade licence and asked about the overdraft limit. ';
    const text = s.repeat(40);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(c.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ')).toBe(text.trim());
  });
  it('splits one over-long sentence at whitespace, and hard when there is none', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    for (const c of chunkText(words))
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
    const blob = 'x'.repeat(2000);
    expect(chunkText(blob).map((c) => c.length)).toEqual([800, 800, 400]);
  });
});

describe('022a brainRedact', () => {
  it('never keeps a phone number or a 15-digit ID number', () => {
    const cases = [
      'Call me on +971 50 123 4567 tomorrow',
      'whatsapp 971501234567',
      'my number is 050-123-4567',
      'EID 784-1990-1234567-1',
      'ID number 123456789012345 attached',
      'ref 1234 5678 9012 345 please',
      'arabic digits ١٢٣٤٥٦٧٨٩٠١٢٣٤٥',
    ];
    for (const c of cases) {
      const r = brainRedact(c);
      expect(r.ok, c).toBe(true);
      if (!r.ok) continue;
      expect(r.text, c).not.toMatch(PHONE_RE);
      expect(r.text.replace(/\D/g, '').length, c).toBeLessThan(9);
      expect(r.text.replace(/[^\p{Nd}]/gu, '').length, c).toBeLessThan(9);
    }
  });
  it('masks a bare 9+ digit run the 019b redactor leaves alone as [ID]', () => {
    expect(brainRedact('ID number 123456789012345 attached')).toEqual({
      ok: true,
      text: 'ID number [ID] attached',
    });
  });
  // SQL's TEXT_UNREDACTED guard (brain_item_upsert, brain_page_put) as a JS
  // regex: whatever brainRedact returns must never match it, or the chunk is
  // refused at ingest.
  const SQL_GUARD = /[0-9٠-٩۰-۹０-９](?:[-./()\s]{0,2}[0-9٠-٩۰-۹０-９]){8,}/u;
  it('masks Arabic-Indic, full-width, slash and bracket numbers as [ID]', () => {
    const cases: Array<[string, string]> = [
      ['ref ٠٥٠١٢٣٤٥٦٧٨ end', 'ref [ID] end'],
      ['ref ۰۵۰۱۲۳۴۵۶۷۸ end', 'ref [ID] end'],
      ['ref ０５０１２３４５６７ end', 'ref [PHONE:567] end'], // 019b's phone rule
      ['ref １２３４５６７８９ end', 'ref [ID] end'],
      ['ref 9876/5432/1 end', 'ref [ID] end'],
      ['ref 987)(654)(321 end', 'ref [ID] end'],
      ['ref (987) 654-321 end', 'ref ([ID] end'],
      ['ref 12/34/56/78/9 end', 'ref [ID] end'],
    ];
    for (const [input, want] of cases) {
      expect(brainRedact(input), input).toEqual({ ok: true, text: want });
    }
  });
  it('never returns text the SQL digit guard refuses', () => {
    const cases = [
      'call ٠٥٠١٢٣٤٥٦٧٨',
      'call ۰۵۰۱۲۳۴۵۶۷۸',
      'call ０５０１２３４５６７',
      'call 050/123/4567',
      'call (050) 123-4567',
      'call (050)(123)(4567)',
      'ids 1234/5678/9 and 9876.5432.1',
    ];
    for (const c of cases) {
      expect(c, c).toMatch(SQL_GUARD);
      const r = brainRedact(c);
      expect(r.ok, c).toBe(true);
      if (!r.ok) continue;
      expect(r.text, c).not.toMatch(SQL_GUARD);
    }
  });
  it('keeps ordinary text and short numbers', () => {
    const r = brainRedact(
      'Limit AED 250000 approved on 12 Oct for case TC-12.'
    );
    expect(r).toEqual({
      ok: true,
      text: 'Limit AED 250000 approved on 12 Oct for case TC-12.',
    });
  });
  it('fails closed when the 019b redactor refuses', () => {
    const r = brainRedact(42 as unknown as string);
    expect(r.ok).toBe(false);
  });
});

describe('022a HashingEmbedder (UNVERIFIED semantics)', () => {
  const e = new HashingEmbedder();
  it('is deterministic, 256-dim and L2 normalised', async () => {
    const [a] = await e.embed(['Trade licence renewal for the bank']);
    const [b] = await e.embed(['Trade licence renewal for the bank']);
    expect(e.dim).toBe(256);
    expect(e.model).toBe('hashing-v1-256');
    expect(a).toEqual(b);
    expect(a!.length).toBe(256);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
    expect(e.embedOne('').every((x) => x === 0)).toBe(true);
  });
  it('ranks a text sharing words above unrelated texts', () => {
    const q = e.embedOne('trade licence expiry');
    const near = cosine(
      q,
      e.embedOne('The trade licence expiry date is next month')
    );
    const far1 = cosine(q, e.embedOne('Salary certificate from the employer'));
    const far2 = cosine(
      q,
      e.embedOne('Customer prefers a call in the afternoon')
    );
    expect(near).toBeGreaterThan(0.4);
    expect(near).toBeGreaterThan(far1 + 0.2);
    expect(near).toBeGreaterThan(far2 + 0.2);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('022a ingest (in-memory ports)', () => {
  it('stores only redacted chunks: no phone, no 15-digit ID ever reaches the store', async () => {
    const m = new MemPorts();
    const r = await ingestMessage(deps(m), {
      accountId: 'acc1',
      messageId: 'wamid.1',
      caseId: 'c',
      contactId: 'k',
      text: 'Please call +971 50 123 4567. My ID number is 123456789012345 and EID 784-1990-1234567-1.',
    });
    expect(r.ok).toBe(true);
    expect(m.items.length).toBe(1);
    const stored = m.items[0]!.text;
    expect(stored).not.toMatch(PHONE_RE);
    expect(stored).not.toContain('123456789012345');
    expect(stored).not.toContain('4567');
    expect(stored).toContain('[PHONE:567]');
    expect(m.vecs.size).toBe(1);
  });
  it('chunks long notes, embeds each stored chunk, and re-ingest is idempotent', async () => {
    const m = new MemPorts();
    const body = Array.from(
      { length: 30 },
      (_, i) => `The coordinator reviewed statement ${i} for the overdraft.`
    ).join(' ');
    const a = await ingestNote(deps(m), {
      accountId: 'acc1',
      noteId: 'n1',
      caseId: 'c',
      body,
    });
    const b = await ingestNote(deps(m), {
      accountId: 'acc1',
      noteId: 'n1',
      caseId: 'c',
      body,
    });
    expect(a.ok && a.itemIds.length).toBeGreaterThan(1);
    expect(b).toEqual(a);
    expect(m.items.length).toBe(a.ok ? a.itemIds.length : -1);
    for (const i of m.items) expect(i.text.length).toBeLessThanOrEqual(800);
  });
  it('remember counts chunks that were already stored', async () => {
    const m = new MemPorts();
    const first = await ingestRemember(
      deps(m),
      'user-x',
      'Bank One wants the MOA.',
      {
        accountId: 'acc1',
      }
    );
    const again = await ingestRemember(
      deps(m),
      'user-x',
      'Bank One wants the MOA.',
      {
        accountId: 'acc1',
      }
    );
    expect(first).toMatchObject({ ok: true, existing: 0 });
    expect(again).toMatchObject({ ok: true, existing: 1 });
    expect(again.ok && again.itemIds).toEqual(first.ok && first.itemIds);
    expect(m.items.length).toBe(1);
  });
  it('other sources never ask whether a chunk exists', async () => {
    const m = new MemPorts();
    const spy = vi.spyOn(m, 'isLive');
    await ingestNote(deps(m), {
      accountId: 'acc1',
      noteId: 'n1',
      body: 'hello',
    });
    expect(spy).not.toHaveBeenCalled();
  });
  it('remember stores the actor as source and creator', async () => {
    const m = new MemPorts();
    await ingestRemember(
      deps(m),
      'user-x',
      'Bank One wants the MOA attested.',
      {
        accountId: 'acc1',
      }
    );
    expect(m.items[0]).toMatchObject({
      sourceKind: 'remember',
      sourceId: 'user-x',
      createdBy: 'user-x',
      systemLabel: null,
      caseId: null,
    });
  });
  it('carries a system writer and the bank code to the store', async () => {
    const m = new MemPorts();
    await ingestMessage(deps(m), {
      accountId: 'acc1',
      messageId: 'wamid.2',
      bankCode: 'ADCB',
      createdBy: null,
      systemLabel: 'system:inbound',
      text: 'Customer asked for the overdraft form.',
    });
    expect(m.items[0]).toMatchObject({
      createdBy: null,
      systemLabel: 'system:inbound',
      bankCode: 'ADCB',
    });
  });
  it('does not embed a chunk the store refused, and counts it as skipped', async () => {
    const m = new MemPorts();
    m.refuse = () => true;
    const r = await ingestNote(deps(m), {
      accountId: 'acc1',
      noteId: 'n2',
      body: 'Opted out.',
    });
    expect(r).toEqual({ ok: true, itemIds: [], skipped: 1, existing: 0 });
    expect(m.vecs.size).toBe(0);
  });
  it('stores nothing when the redactor refuses', async () => {
    const m = new MemPorts();
    const r = await ingestNote(deps(m), {
      accountId: 'acc1',
      noteId: 'n3',
      body: null as unknown as string,
    });
    expect(r.ok).toBe(false);
    expect(m.items).toEqual([]);
  });
});

describe('022a search scoring and audit (in-memory ports)', () => {
  const cand = (
    id: string,
    cos: number,
    kw: number,
    text = `text ${id}`
  ): BrainCandidate => ({
    itemId: id,
    sourceKind: 'note',
    sourceId: `n-${id}`,
    caseId: 'c1',
    contactId: null,
    bankCode: null,
    text,
    aiGenerated: id === 'b',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    cosine: cos,
    kwRank: kw,
  });
  it('blends cosine and keyword rank, drops low scores, cites the source, audits the hash only', async () => {
    const m = new MemPorts();
    m.cands = [
      cand('a', 0.3, 0.0),
      cand('b', 0.9, 0.5),
      cand('c', 0.05, 0.0),
      cand('d', 0.1, 0.9),
    ];
    const hits = await searchBrain(deps(m), {
      actorId: 'user-x',
      accountId: 'acc1',
      query: 'overdraft for +971 50 123 4567',
    });
    expect(hits.map((h) => h.itemId)).toEqual(['b', 'd', 'a']);
    expect(hits[0]).toMatchObject({
      aiGenerated: true,
      citation: { kind: 'note', id: 'n-b' },
      caseId: 'c1',
    });
    expect(hits[0]!.score).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.5, 10);
    expect(m.lastQuery!.queryText).not.toContain('4567');
    expect(m.lastQuery).toMatchObject({
      actorId: 'user-x',
      accountId: 'acc1',
      model: 'hashing-v1-256',
      limit: 50,
    });
    expect(m.audits).toEqual([
      {
        account: 'acc1',
        actor: 'user-x',
        sha: sha256Hex(m.lastQuery!.queryText),
        n: 3,
      },
    ]);
    expect(JSON.stringify(m.audits)).not.toContain('overdraft');
  });
  it('a blank query asks for no candidates but is still audited', async () => {
    const m = new MemPorts();
    const hits = await searchBrain(deps(m), {
      actorId: 'user-x',
      accountId: 'acc1',
      query: '   ',
    });
    expect(hits).toEqual([]);
    expect(m.lastQuery).toBeNull();
    expect(m.audits).toEqual([
      { account: 'acc1', actor: 'user-x', sha: sha256Hex('   '), n: 0 },
    ]);
  });
  it('snippets are at most 240 chars around the first query term', () => {
    const text = `${'a '.repeat(200)}overdraft limit ${'b '.repeat(200)}`;
    const s = snippet(text, ['overdraft']);
    expect(s.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(s).toContain('overdraft');
    expect(snippet('short', ['x'])).toBe('short');
  });
});

describe('022a no path from the vault or document files', () => {
  it('lib/brain imports neither the vault nor case document intake', () => {
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/from '[^']*vault[^']*'/);
      expect(src, f).not.toMatch(/from '[^']*(customer-docs|case-files)[^']*'/);
      expect(/^[\x00-\x7f]*$/.test(src), `${f} is ASCII`).toBe(true);
    }
  });
});
