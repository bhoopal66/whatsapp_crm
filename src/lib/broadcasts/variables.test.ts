import { describe, expect, it } from 'vitest';
import type { Contact } from '@/types';
import {
  countBlankVariables,
  csvValuesForContact,
  indexCsvRowsByPhone,
  resolveVariableWithFallback,
  resolveVariables,
  sortedVariableKeys,
  type CsvContactRow,
  type VariableMapping,
} from './variables';

const contact: Contact = {
  id: 'c1',
  user_id: 'u',
  account_id: 'a',
  name: 'Alice (CRM)',
  phone: '+971 50 123 4567',
  email: 'alice@example.com',
  company: 'Acme',
  created_at: '',
  updated_at: '',
};

describe('sortedVariableKeys', () => {
  it('orders numeric keys numerically so {{10}} follows {{2}}', () => {
    expect(
      sortedVariableKeys({
        '10': { type: 'static', value: '' },
        '2': { type: 'static', value: '' },
        '1': { type: 'static', value: '' },
      })
    ).toEqual(['1', '2', '10']);
  });
});

describe('resolveVariables', () => {
  const variables: Record<string, VariableMapping> = {
    '1': { type: 'field', value: 'name' },
    '2': { type: 'custom_field', value: 'cf-plan' },
    '3': { type: 'csv_column', value: 'order id' },
    '4': { type: 'static', value: 'Thanks!' },
  };

  it('resolves each source in send order', () => {
    expect(
      resolveVariables(variables, contact, new Map([['cf-plan', 'Gold']]), {
        'order id': 'A-1001',
      })
    ).toEqual(['Alice (CRM)', 'Gold', 'A-1001', 'Thanks!']);
  });

  it('sends an empty string for anything the recipient lacks', () => {
    expect(resolveVariables(variables, contact)).toEqual([
      'Alice (CRM)',
      '',
      '',
      'Thanks!',
    ]);
  });

  it('reads a CSV column from the recipient row, not the CRM contact', () => {
    // The contact pre-dated the upload under a different name; the
    // column the admin picked in the file is what goes out.
    expect(
      resolveVariables(
        { '1': { type: 'csv_column', value: 'name' } },
        contact,
        undefined,
        {
          name: 'Alice from CSV',
        }
      )
    ).toEqual(['Alice from CSV']);
  });
});

describe('resolveVariables — fallback', () => {
  // Meta refuses a blank text parameter (#131008): a Compass field most
  // customers lacked failed a whole campaign. The fallback is what
  // those recipients get instead.
  const mapping: VariableMapping = {
    type: 'csv_column',
    value: 'contact_person',
    fallback: 'Sir/Madam',
  };

  it('uses the fallback for an empty cell', () => {
    expect(
      resolveVariables({ '1': mapping }, contact, undefined, {
        contact_person: '',
      })
    ).toEqual(['Sir/Madam']);
  });

  it('uses the fallback for a whitespace-only cell', () => {
    expect(
      resolveVariables({ '1': mapping }, contact, undefined, {
        contact_person: '   ',
      })
    ).toEqual(['Sir/Madam']);
  });

  it('uses the fallback when the column is missing from the row', () => {
    expect(
      resolveVariables({ '1': mapping }, contact, undefined, { other: 'x' })
    ).toEqual(['Sir/Madam']);
    expect(resolveVariables({ '1': mapping }, contact)).toEqual(['Sir/Madam']);
  });

  it('keeps a real value over the fallback', () => {
    expect(
      resolveVariables({ '1': mapping }, contact, undefined, {
        contact_person: 'Omar',
      })
    ).toEqual(['Omar']);
  });

  it('applies to contact fields and custom fields too', () => {
    const noEmail = { ...contact, email: null } as unknown as Contact;
    expect(
      resolveVariables(
        {
          '1': { type: 'field', value: 'email', fallback: 'no email' },
          '2': { type: 'custom_field', value: 'cf-plan', fallback: 'Basic' },
        },
        noEmail,
        new Map([['cf-plan', ' ']])
      )
    ).toEqual(['no email', 'Basic']);
  });

  it('applies to an empty static value', () => {
    expect(
      resolveVariables(
        { '1': { type: 'static', value: '', fallback: 'friend' } },
        contact
      )
    ).toEqual(['friend']);
  });

  it('trims the fallback and ignores a blank one', () => {
    expect(
      resolveVariables(
        {
          '1': { ...mapping, fallback: '  Sir  ' },
          '2': { ...mapping, fallback: '   ' },
        },
        contact
      )
    ).toEqual(['Sir', '']);
  });

  it('leaves the preview resolver undefined when there is no fallback', () => {
    const bare: VariableMapping = { type: 'csv_column', value: 'x' };
    expect(resolveVariableWithFallback(bare, contact)).toBeUndefined();
    expect(resolveVariableWithFallback(mapping, contact)).toBe('Sir/Madam');
  });
});

describe('countBlankVariables', () => {
  const rows: CsvContactRow[] = [
    { phone: '1', name: 'A', values: { contact_person: 'Omar', city: '' } },
    { phone: '2', name: 'B', values: { contact_person: ' ' } },
    { phone: '3', values: {} },
    { phone: '4', name: 'D', values: { city: 'Dubai' } },
  ];

  it('counts rows each mapping would leave blank, in send order', () => {
    expect(
      countBlankVariables(
        {
          '2': { type: 'field', value: 'name' },
          '1': { type: 'csv_column', value: 'contact_person' },
          '3': { type: 'csv_column', value: 'city' },
        },
        rows
      )
    ).toEqual([
      { key: '1', blank: 3, total: 4 },
      { key: '2', blank: 1, total: 4 },
      { key: '3', blank: 3, total: 4 },
    ]);
  });

  it('skips mappings with a fallback, and ones a row cannot answer', () => {
    expect(
      countBlankVariables(
        {
          '1': {
            type: 'csv_column',
            value: 'contact_person',
            fallback: 'Sir/Madam',
          },
          '2': { type: 'custom_field', value: 'cf-plan' },
          '3': { type: 'static', value: '' },
          '4': { type: 'csv_column', value: '' },
          '5': { type: 'field', value: 'phone' },
        },
        rows
      )
    ).toEqual([]);
  });

  it('still counts a mapping whose fallback is blank', () => {
    expect(
      countBlankVariables(
        { '1': { type: 'csv_column', value: 'city', fallback: ' ' } },
        rows
      )
    ).toEqual([{ key: '1', blank: 3, total: 4 }]);
  });

  it('has nothing to say without rows', () => {
    expect(
      countBlankVariables({ '1': { type: 'csv_column', value: 'city' } }, [])
    ).toEqual([]);
  });
});

describe('indexCsvRowsByPhone / csvValuesForContact', () => {
  it('matches a resolved contact to its row on the normalized phone', () => {
    const index = indexCsvRowsByPhone([
      { phone: '971501234567', values: { phone: '971501234567', due: 'Mon' } },
      { phone: '+971 55 987 6543', values: { due: 'Tue' } },
    ]);
    expect(csvValuesForContact(index, contact)).toEqual({
      phone: '971501234567',
      due: 'Mon',
    });
    expect(csvValuesForContact(index, { phone: '+971559876543' })).toEqual({
      due: 'Tue',
    });
    expect(
      csvValuesForContact(index, { phone: '+10000000000' })
    ).toBeUndefined();
  });

  it('keeps the first row for a duplicated phone, like the upsert does', () => {
    const index = indexCsvRowsByPhone([
      { phone: '+15551234567', values: { due: 'first' } },
      { phone: '15551234567', values: { due: 'second' } },
    ]);
    expect(index.get('15551234567')).toEqual({ due: 'first' });
  });
});
