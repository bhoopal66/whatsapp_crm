import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planImport } from './import-contacts';
import {
  CONTACT_FILE_ACCEPT,
  contactFileProblem,
  readContactFile,
} from './read-contact-file';
import { sheet, simpleBook, workbook, zip } from './xlsx.fixture';

const file = (name: string, bytes: Uint8Array) =>
  new File([bytes as Uint8Array<ArrayBuffer>], name);

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

const HEADER = `<row r="3">${text('A3', 'Phone Number')}${text('B3', 'Name')}</row>`;

describe('readContactFile', () => {
  it('reads an .xlsx into the plan a CSV gets, rows by their sheet row', async () => {
    const parsed = await readContactFile(
      file(
        'Customers.XLSX',
        simpleBook(
          HEADER +
            `<row r="4"><c r="A4"><v>971501234567</v></c>${text('B4', 'محمد')}</row>` +
            `<row r="6">${text('B6', 'No number')}</row>` +
            `<row r="7">${text('A7', '12')}</row>`
        )
      )
    );
    expect(parsed).toMatchObject({
      phoneColumn: 'phone number',
      noPhoneLines: [6],
      badLines: [],
    });
    const plan = await planImport(parsed, async () => ({
      data: [],
      error: null,
    }));
    expect(plan.toInsert).toMatchObject([
      { phone: '971501234567', name: 'محمد', line: 4 },
    ]);
    expect(plan.problems.map((p) => [p.line, p.reason])).toEqual([
      [6, 'no_phone'],
      [7, 'phone'],
    ]);
  });

  it('reads an .xlsx date and percentage as shown, its phones as digits', async () => {
    const styles =
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/>' +
      '<xf numFmtId="164"/></cellXfs>';
    const parsed = await readContactFile(
      file(
        'due.xlsx',
        simpleBook(
          `<row r="1">${text('A1', 'Mobile')}${text('B1', 'Due')}${text('C1', 'Rate')}</row>` +
            // A phone as a number, as text, and in a date-formatted cell,
            // once small enough to be a day.
            '<row r="2"><c r="A2"><v>9.71501234567E+11</v></c><c r="B2" s="1"><v>46371</v></c><c r="C2" s="2"><v>7.2499999999999995E-2</v></c></row>' +
            `<row r="3">${text('A3', '+971 50 123 4568')}</row>` +
            '<row r="4"><c r="A4" s="1"><v>971501234569</v></c></row>' +
            '<row r="5"><c r="A5" s="1"><v>501234</v></c></row>',
          undefined,
          styles
        )
      )
    );
    expect(parsed.rows.map((r) => r.phone)).toEqual([
      '971501234567',
      '+971 50 123 4568',
      '971501234569',
      '501234',
    ]);
    expect(parsed.rows[0].values).toEqual({
      mobile: '971501234567',
      due: '15/12/2026',
      rate: '7.25%',
    });
  });

  it('reads a UTF-16 CSV', async () => {
    const bytes = Buffer.from(
      '\ufeffphone\tname\r\n+971501234567\tمحمد\r\n',
      'utf16le'
    );
    expect((await readContactFile(file('list.csv', bytes))).rows).toMatchObject(
      [{ phone: '+971501234567', name: 'محمد' }]
    );
  });

  it('reads a Windows-1256 CSV', async () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('phone,name\r\n+971501234567,'),
      ...[0xe3, 0xcd, 0xe3, 0xcf],
    ]);
    expect((await readContactFile(file('list.csv', bytes))).rows).toMatchObject(
      [{ phone: '+971501234567', name: 'محمد' }]
    );
  });

  it('refuses each unreadable file with its own message', async () => {
    const problem = async (name: string, bytes: Uint8Array) =>
      contactFileProblem(
        await readContactFile(file(name, bytes)).then(
          () => null,
          (err: unknown) => err
        )
      );
    const csv = (s: string) => new TextEncoder().encode(s);
    expect((await problem('old.xls', csv('x'))).key).toBe('errorXls');
    expect((await problem('lost.csv', csv('phone\n�'))).key).toBe(
      'errorEncoding'
    );
    expect((await problem('not.xlsx', csv('phone\n1'))).key).toBe(
      'errorCsvParse'
    );
    // The reader's own limits: past Excel's last row, and too many tabs.
    const tooLong = simpleBook(
      '<row r="1048577"><c r="A1048577"><v>1</v></c></row>'
    );
    expect(await problem('long.xlsx', tooLong)).toEqual({
      key: 'errorXlsxLimit',
      reason: "Row 1048577 is outside Excel's rows 1 to 1048576",
    });
    const tabs = zip([
      ...workbook(
        Array.from({ length: 51 }, (_, i) => ({ name: `S${i}`, rid: 'rId1' })),
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ),
      { name: 'xl/worksheets/sheet1.xml', content: sheet('') },
    ]);
    expect(await problem('tabs.xlsx', tabs)).toMatchObject({
      key: 'errorXlsxLimit',
      reason: expect.stringContaining('more than 50 sheets'),
    });
  });

  it.each([
    'src/components/contacts/import-modal.tsx',
    'src/components/broadcasts/step2-select-audience.tsx',
  ])('%s reads its file here, .xlsx included', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).toContain('accept={CONTACT_FILE_ACCEPT}');
    expect(source).toContain('await readContactFile(');
    expect(CONTACT_FILE_ACCEPT).toContain('.xlsx');
  });
});
