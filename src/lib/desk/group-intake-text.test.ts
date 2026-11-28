import { describe, expect, it } from 'vitest';

import {
  QUEUE_REASON_TEXT,
  groupReplyText,
  queueReasonText,
  refusalText,
} from './group-intake-text';
import { QUEUE_REASON_KEYS } from './intake-form';

describe('queueReasonText', () => {
  it.each([
    ['NO_KIND', 'the caption does not say what the file is'],
    [
      'NO_CASE',
      'the caption does not name a case, or the new case details are incomplete',
    ],
    ['NO_CONTACT', 'the new case has no customer contact yet'],
    ['NO_FILE', 'a pending document needs a file'],
    ['CASE_NOT_FOUND', 'no open case matches that number or code'],
    ['BANK_MISMATCH', 'that case is at a different bank'],
    [
      'CASE_EXISTS_NAME_MISMATCH',
      'that licence is on file under another company name',
    ],
    ['COMPANY_RESTRICTED', 'this company or customer is with a colleague'],
  ])('%s', (reason, words) => {
    expect(queueReasonText(reason)).toBe(words);
  });

  it('covers every queue reason the desk names', () => {
    expect(Object.keys(QUEUE_REASON_TEXT).sort()).toEqual(
      [...QUEUE_REASON_KEYS].sort()
    );
  });

  it('falls back for a refusal hint or nothing', () => {
    expect(queueReasonText('CASE_OPEN_FAILED')).toBe(
      'it could not be filed automatically'
    );
    expect(queueReasonText(null)).toBe('it could not be filed automatically');
  });
});

describe('refusalText', () => {
  it.each([
    ['NOT_ALLOWED', 'your login cannot upload to the case desk'],
    ['FILE_INVALID', 'the file is not a readable PDF, JPEG or PNG'],
    ['INVALID', 'the caption could not be read'],
    ['BANK_UNKNOWN', 'the bank in the caption is not known'],
    ['CASE_CLOSED', 'that case is closed'],
    ['CASE_NOT_FOUND', 'no open case matches that number or code'],
    ['COMPANY_RESTRICTED', 'this company or customer is with a colleague'],
  ])('%s', (code, words) => {
    expect(refusalText(code)).toBe(words);
  });

  it('falls back for any other code', () => {
    expect(refusalText('SEQ_EXHAUSTED')).toBe(
      'it could not be filed automatically'
    );
    expect(refusalText(null)).toBe('it could not be filed automatically');
  });
});

describe('groupReplyText', () => {
  it('filed names the case and the document', () => {
    expect(
      groupReplyText({
        kind: 'filed',
        caseNumber: 'TC-26-00412-RAK',
        docKey: 'ejari',
      })
    ).toBe('Filed to TC-26-00412-RAK as Ejari.');
    expect(
      groupReplyText({
        kind: 'filed',
        caseNumber: 'TC-26-00412-RAK',
        docKey: null,
      })
    ).toBe('Filed to TC-26-00412-RAK.');
  });

  it('a new case gives its caption code', () => {
    expect(
      groupReplyText({
        kind: 'new_case',
        caseNumber: 'TC-26-00431-RAK',
        captionCode: '431RAK5',
      })
    ).toBe('New case TC-26-00431-RAK opened. Caption code 431RAK5');
  });

  it('queued names the queue and the plain reason', () => {
    expect(
      groupReplyText({
        kind: 'queued',
        queueName: 'RAKBANK',
        reason: 'NO_KIND',
      })
    ).toBe(
      'Sent to the RAKBANK sorting queue: the caption does not say what the file is.'
    );
    expect(
      groupReplyText({ kind: 'queued', queueName: null, reason: 'X' })
    ).toBe('Sent to the sorting queue: it could not be filed automatically.');
  });

  it('duplicate and refused', () => {
    expect(groupReplyText({ kind: 'duplicate' })).toBe(
      'Already on this case - nothing more to do.'
    );
    expect(groupReplyText({ kind: 'refused', code: 'NOT_ALLOWED' })).toBe(
      'Could not file: your login cannot upload to the case desk.'
    );
  });
});
