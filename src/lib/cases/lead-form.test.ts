import { describe, expect, it } from 'vitest';

import {
  buildLeadRequest,
  createdLeadId,
  leadErrorKey,
  parseContactCases,
  type LeadFormInput,
} from './lead-form';

const base: LeadFormInput = {
  contactId: 'k1',
  bankCode: 'ADCB',
  product: 'Home loan',
  amount: '',
  leadSource: '',
  agentId: null,
  canPickAgent: false,
};

describe('buildLeadRequest', () => {
  it('sends only the required fields when the optional ones are empty', () => {
    expect(buildLeadRequest(base)).toEqual({
      ok: true,
      body: { contactId: 'k1', bankCode: 'ADCB', product: 'Home loan' },
    });
  });

  it('trims, normalises the amount and keeps the lead source', () => {
    const r = buildLeadRequest({
      ...base,
      product: '  Home loan ',
      amount: '1,250,000.50',
      leadSource: ' Walk-in ',
    });
    expect(r).toEqual({
      ok: true,
      body: {
        contactId: 'k1',
        bankCode: 'ADCB',
        product: 'Home loan',
        amount: '1250000.50',
        leadSource: 'Walk-in',
      },
    });
  });

  it('an agent never sends agentId; a leader sends the picked one', () => {
    const agent = buildLeadRequest({ ...base, agentId: 'u2' });
    expect(agent.ok && 'agentId' in agent.body).toBe(false);
    const leader = buildLeadRequest({
      ...base,
      agentId: 'u2',
      canPickAgent: true,
    });
    expect(leader.ok && leader.body.agentId).toBe('u2');
  });

  it.each([
    [{ bankCode: ' ' }, 'bankRequired'],
    [{ product: '   ' }, 'productRequired'],
    [{ product: 'x'.repeat(201) }, 'productTooLong'],
    [{ amount: '12.345' }, 'amountInvalid'],
    [{ amount: '-5' }, 'amountInvalid'],
    [{ amount: '1'.repeat(17) }, 'amountInvalid'],
    [{ leadSource: 'y'.repeat(201) }, 'sourceTooLong'],
  ] as const)('refuses %j with %s', (over, error) => {
    expect(buildLeadRequest({ ...base, ...over })).toEqual({
      ok: false,
      error,
    });
  });

  it('accepts 200 characters of product and source, and 16 digits', () => {
    const r = buildLeadRequest({
      ...base,
      product: 'x'.repeat(200),
      leadSource: 'y'.repeat(200),
      amount: '9'.repeat(16) + '.99',
    });
    expect(r.ok).toBe(true);
  });
});

describe('leadErrorKey', () => {
  it.each([
    [409, 'LEAD_EXISTS', 'leadExists'],
    [409, 'CASE_EXISTS', 'caseExists'],
    [422, 'LEAD_INVALID', 'leadInvalid'],
    [422, 'BANK_UNKNOWN', 'bankUnknown'],
    [422, 'ASSIGNEE_INVALID', 'assigneeInvalid'],
    [422, 'SOMETHING_NEW', 'generic'],
    [400, undefined, 'generic'],
    [500, 'LEAD_EXISTS', 'generic'],
    [0, undefined, 'generic'],
  ])('%i %s -> %s', (status, code, key) => {
    expect(leadErrorKey(status, code)).toBe(key);
  });
});

describe('createdLeadId', () => {
  it('reads the id or answers null', () => {
    expect(createdLeadId({ id: 'c1' })).toBe('c1');
    expect(createdLeadId({ id: '' })).toBeNull();
    expect(createdLeadId(null)).toBeNull();
  });
});

describe('parseContactCases', () => {
  it('reads rows and drops malformed ones', () => {
    expect(
      parseContactCases({
        cases: [
          {
            id: 'c1',
            stage: 'Interested',
            bankCode: 'ADCB',
            product: 'Home loan',
            amount: '1500.00',
            isLead: true,
            openedAt: '2026-10-01T00:00:00Z',
            closedAt: null,
          },
          { id: 'c2', stage: 'Submitted', amount: 12.5, isLead: 'yes' },
          { stage: 'Review' },
          null,
        ],
      })
    ).toEqual([
      {
        id: 'c1',
        stage: 'Interested',
        bankCode: 'ADCB',
        product: 'Home loan',
        amount: '1500.00',
        isLead: true,
        openedAt: '2026-10-01T00:00:00Z',
        closedAt: null,
      },
      {
        id: 'c2',
        stage: 'Submitted',
        bankCode: null,
        product: null,
        amount: '12.5',
        isLead: false,
        openedAt: null,
        closedAt: null,
      },
    ]);
    expect(parseContactCases(null)).toEqual([]);
    expect(parseContactCases({ cases: 'x' })).toEqual([]);
  });
});
