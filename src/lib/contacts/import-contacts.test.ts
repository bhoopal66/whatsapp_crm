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
  it('asks only about the file, every stored form, 200 keys at a time, 4 at once', async () => {
    const asked: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const plan = await planImport(file(rows(1250)), async (chunk) => {
      asked.push(chunk.length);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      // Everything from 1,100 up already exists, in its exact form.
      return {
        data: chunk
          .filter((p) => p.startsWith('971') && Number(p.slice(5)) >= 1001100)
          .map((phone_normalized) => ({ phone_normalized })),
        error: null,
      };
    });
    // 1,250 numbers, six forms each.
    expect(asked.reduce((a, b) => a + b, 0)).toBe(1250 * 6);
    expect(Math.max(...asked)).toBe(200);
    expect(peak).toBe(4);
    expect(plan.toInsert).toHaveLength(1100);
    expect(plan.alreadyThere).toBe(150);
    expect(plan.savedElsewhere).toEqual([]);
  });

  it('counts a customer saved in local form as already there', async () => {
    const plan = await planImport(
      file([
        { phone: '+971 50 123 0043', values: {}, line: 2 },
        { phone: '+971 50 123 0044', values: {}, line: 3 },
        { phone: '+966 50 123 0045', values: {}, line: 4 },
      ]),
      async () => ({
        // Two rows match the first number; Saudi 0501230045 is not it.
        data: [
          { phone_normalized: '0501230043' },
          { phone_normalized: '501230043' },
          { phone_normalized: '0501230045' },
        ],
        error: null,
      })
    );
    expect(plan.alreadyThere).toBe(1);
    expect(plan.savedElsewhere).toMatchObject([
      { line: 2, phone: '971501230043' },
    ]);
    expect(['0501230043', '501230043']).toContain(
      plan.savedElsewhere[0].savedAs
    );
    expect(plan.toInsert.map((r) => r.line)).toEqual([3, 4]);
    expect(plan.problems).toEqual([]);
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
