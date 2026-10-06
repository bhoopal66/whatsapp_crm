import { describe, expect, it } from 'vitest';
import type { Contact } from '@/types';
import {
  csvValuesForContact,
  indexCsvRowsByPhone,
  resolveVariables,
  sortedVariableKeys,
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
