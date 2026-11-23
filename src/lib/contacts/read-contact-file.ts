import { readTextFile, TextEncodingError } from '@/lib/csv/decode-text';
import {
  parseContactTable,
  readContactCsv,
  type ReadContactCsvResult,
} from './parse-contact-csv';
import { readXlsxFirstSheet, XlsxLimitError } from './read-xlsx';

// A contact list as people have it: a CSV, or an Excel workbook's first
// visible sheet. The contacts import and the broadcast list read the
// same files the same way.

/** A file input's `accept` for {@link readContactFile}. */
export const CONTACT_FILE_ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The pre-2007 binary format: not a ZIP of XML, so not readable here. */
class OldExcelError extends Error {}

/** The contacts of a .csv or .xlsx, with the lines that gave no contact. */
export async function readContactFile(
  file: File
): Promise<ReadContactCsvResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls')) throw new OldExcelError();
  if (!name.endsWith('.xlsx')) return readContactCsv(await readTextFile(file));
  const { rows, firstRow } = await readXlsxFirstSheet(
    new Uint8Array(await file.arrayBuffer())
  );
  const parsed = parseContactTable(
    rows,
    rows.map((_, i) => firstRow + i)
  );
  return { ...parsed, noPhoneLines: parsed.noPhoneLines ?? [], badLines: [] };
}

/** Why a file was refused, as a catalogue key, and the limit it passed. */
export function contactFileProblem(err: unknown): {
  key: 'errorXls' | 'errorXlsxLimit' | 'errorEncoding' | 'errorCsvParse';
  reason: string;
} {
  if (err instanceof OldExcelError) return { key: 'errorXls', reason: '' };
  if (err instanceof XlsxLimitError)
    return { key: 'errorXlsxLimit', reason: err.message };
  if (err instanceof TextEncodingError)
    return { key: 'errorEncoding', reason: '' };
  return { key: 'errorCsvParse', reason: '' };
}
