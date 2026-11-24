import { describe, expect, it } from 'vitest';
import { normalizeStatus } from './template-status-normalize';

describe('normalizeStatus', () => {
  it('passes through known Meta statuses verbatim', () => {
    expect(normalizeStatus('APPROVED')).toBe('APPROVED');
    expect(normalizeStatus('PAUSED')).toBe('PAUSED');
    expect(normalizeStatus('IN_APPEAL')).toBe('IN_APPEAL');
  });
  it('uppercases lowercase input', () => {
    expect(normalizeStatus('approved')).toBe('APPROVED');
  });
  it('maps PENDING_REVIEW → PENDING', () => {
    expect(normalizeStatus('PENDING_REVIEW')).toBe('PENDING');
  });
  it('reads REINSTATED and FLAGGED as usable', () => {
    expect(normalizeStatus('REINSTATED')).toBe('APPROVED');
    expect(normalizeStatus('FLAGGED')).toBe('APPROVED');
  });
  it('reads DELETED as unusable', () => {
    expect(normalizeStatus('DELETED')).toBe('DISABLED');
  });
  it('is null for a value that is not a status, never a guess', () => {
    expect(normalizeStatus('SOMETHING_NEW')).toBeNull();
    expect(normalizeStatus('')).toBeNull();
    expect(normalizeStatus('constructor')).toBeNull();
  });
});
