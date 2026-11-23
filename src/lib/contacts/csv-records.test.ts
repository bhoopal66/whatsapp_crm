import { describe, expect, it } from 'vitest';
import { csvSeparator, parseCsvRecords } from './csv-records';
import {
  contactCsvTable,
  parseContactCsv,
  readContactCsv,
} from './parse-contact-csv';

const cells = (text: string) =>
  parseCsvRecords(text).records.map((r) => r.cells);

describe('parseCsvRecords', () => {
  it('reads doubled quotes, and commas and line breaks inside quotes', () => {
    expect(
      cells(
        'name,phone\r\n"Al Noor ""Best"" Trading, LLC",1\r\n"Two\r\nlines",2\r\n'
      )
    ).toEqual([
      ['name', 'phone'],
      ['Al Noor "Best" Trading, LLC', '1'],
      ['Two\r\nlines', '2'],
    ]);
  });

  it('counts lines across a multi-line cell, and drops blank lines', () => {
    const { records } = parseCsvRecords('﻿a,b\n"x\ny",1\n\nz,2\n\n\n');
    expect(records).toEqual([
      { cells: ['a', 'b'], line: 1 },
      { cells: ['x\ny', '1'], line: 2 },
      { cells: ['z', '2'], line: 5 },
    ]);
  });

  it('keeps a quote inside an unquoted cell, and text after a closing one', () => {
    expect(cells('a,b\nAl "Best" Trading,O\'Brien\n"Al" Noor,1')).toEqual([
      ['a', 'b'],
      ['Al "Best" Trading', "O'Brien"],
      ['Al Noor', '1'],
    ]);
  });

  it('reports a quote that never closes and reads the rows after it', () => {
    expect(parseCsvRecords('a,b\n1,"open\n2,y\n3,z')).toEqual({
      records: [
        { cells: ['a', 'b'], line: 1 },
        { cells: ['2', 'y'], line: 3 },
        { cells: ['3', 'z'], line: 4 },
      ],
      badLines: [2],
    });
  });

  it('does not let two stray quotes swallow the rows between them', () => {
    const { records, badLines } = parseCsvRecords('a,b\n"x,1\ny,2\n"z,3\nw,4');
    expect(records.map((r) => r.cells[0])).toEqual(['a', 'y', 'w']);
    expect(badLines).toEqual([2, 4]);
  });

  it('takes ; or a tab from a header with no comma', () => {
    expect(csvSeparator('name;phone')).toBe(';');
    expect(csvSeparator('name\tphone')).toBe('\t');
    expect(csvSeparator('"a;b",phone')).toBe(',');
    expect(csvSeparator('phone')).toBe(',');
    expect(cells('name;phone\nAcme, LLC;1')[1]).toEqual(['Acme, LLC', '1']);
  });
});

describe('contacts CSV', () => {
  it('imports names as written, a line break as a space', () => {
    const { rows } = parseContactCsv(
      'phone,name\n1,"Al Noor ""Best"" Trading"\n2,"Al\nNoor"\n3,O\'Brien'
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Al Noor "Best" Trading',
      'Al Noor',
      "O'Brien",
    ]);
  });

  it('still strips quotes from phones and headers', () => {
    expect(contactCsvTable("'phone',name\n'+971501234567,A")).toEqual([
      ['phone', 'name'],
      ['+971501234567', 'A'],
    ]);
  });

  it('reports rows it could not read and rows with no phone by line', () => {
    const { rows, badLines, noPhoneLines } = readContactCsv(
      'phone,name\n1,A\n,B\n2,"C\n3,D'
    );
    expect(rows.map((r) => [r.line, r.phone])).toEqual([
      [2, '1'],
      [5, '3'],
    ]);
    expect(noPhoneLines).toEqual([3]);
    expect(badLines).toEqual([4]);
  });
});
