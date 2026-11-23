import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertContacts, planImport } from './import-contacts';
import type { ParsedContactRow } from './parse-contact-csv';

const row = (n: number, line = n + 2): ParsedContactRow => ({
  phone: `+97150${String(1000000 + n)}`,
  values: {},
  line,
});
const rows = (count: number) => Array.from({ length: count }, (_, n) => row(n));
const file = (list: ParsedContactRow[]) => ({
  rows: list,
  badLines: [],
  noPhoneLines: [],
});

describe('planImport', () => {
  it('asks only about the file, 200 numbers at a time, past 1,000', async () => {
    const asked: number[] = [];
    const plan = await planImport(file(rows(1250)), async (chunk) => {
      asked.push(chunk.length);
      // Everything from 1,100 up already exists.
      return {
        data: chunk
          .filter((p) => Number(p.slice(5)) >= 1001100)
          .map((phone_normalized) => ({ phone_normalized })),
        error: null,
      };
    });
    expect(asked).toEqual([200, 200, 200, 200, 200, 200, 50]);
    expect(plan.toInsert).toHaveLength(1100);
    expect(plan.alreadyThere).toBe(150);
  });

  it('matches however the number is typed, and counts repeats', async () => {
    const plan = await planImport(
      file([
        { phone: '+971 50 100 0001', values: {} },
        { phone: '971501000001', values: {} },
        { phone: '+971-50-100-0002', values: {} },
      ]),
      async () => ({
        data: [{ phone_normalized: '971501000001' }],
        error: null,
      })
    );
    expect(plan).toMatchObject({ alreadyThere: 1, repeats: 1, problems: [] });
    expect(plan.toInsert).toHaveLength(1);
  });

  it('lists every row that gives no contact, by line', async () => {
    const plan = await planImport(
      {
        rows: [{ phone: '12', values: {}, line: 3 }],
        badLines: [5],
        noPhoneLines: [2],
      },
      async () => ({ data: [], error: null })
    );
    expect(plan.problems.map((p) => [p.line, p.reason])).toEqual([
      [2, 'no_phone'],
      [3, 'phone'],
      [5, 'unreadable'],
    ]);
  });

  it('does not call numbers new when the read failed', async () => {
    await expect(
      planImport(file(rows(1)), async () => ({
        data: null,
        error: { message: 'timeout' },
      }))
    ).rejects.toThrow('timeout');
  });
});

describe('insertContacts', () => {
  it('retries row by row only the batch that failed', async () => {
    const sizes: number[] = [];
    const out = await insertContacts(rows(120), async (batch) => {
      sizes.push(batch.length);
      if (batch.some((r) => r.line === 62))
        return { error: { code: '23505', message: 'duplicate' } };
      if (batch.some((r) => r.line === 63))
        return { error: { code: '22001', message: 'too long' } };
      return { error: null };
    });
    expect(sizes).toEqual([50, 50, ...Array(50).fill(1), 20]);
    expect(out).toEqual({
      imported: 118,
      alreadyThere: 1,
      failed: [
        {
          line: 63,
          phone: row(61).phone,
          reason: 'save',
          detail: 'too long',
        },
      ],
    });
  });

  it('stops between batches when asked', async () => {
    let calls = 0;
    const out = await insertContacts(
      rows(120),
      async () => {
        calls++;
        return { error: null };
      },
      () => calls === 1
    );
    expect(out.imported).toBe(50);
  });
});

describe('the import modal', () => {
  const modal = readFileSync(
    join(process.cwd(), 'src/components/contacts/import-modal.tsx'),
    'utf8'
  );

  it('asks about the file, never reads every contact', () => {
    expect(modal).toContain('planImport(');
    expect(modal).toContain(".in('phone_normalized', chunk)");
    expect(modal).toContain('insertContacts(');
  });

  it('asks before closing while it imports', () => {
    expect(modal).toContain('if (!next && importing)');
    expect(modal).toContain('setConfirmClose(true)');
  });
});
