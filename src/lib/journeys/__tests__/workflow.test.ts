import { describe, expect, it } from 'vitest';
import { SHIPPED_WORKFLOW, loadWorkflow, validateWorkflow } from '../index';

describe('SHIPPED_WORKFLOW / loadWorkflow', () => {
  it('the shipped workflow validates clean and loads', () => {
    expect(validateWorkflow(SHIPPED_WORKFLOW)).toEqual([]);
    expect(loadWorkflow(structuredClone(SHIPPED_WORKFLOW))).toEqual(
      SHIPPED_WORKFLOW
    );
  });
  it('returns the very object it validated', () => {
    const copy = structuredClone(SHIPPED_WORKFLOW);
    expect(loadWorkflow(copy)).toBe(copy);
  });
  it("throws, naming the validator's errors, on an invalid definition", () => {
    const bad = structuredClone(SHIPPED_WORKFLOW);
    bad.optOut.keepStates = ['NOPE'];
    expect(validateWorkflow(bad)).not.toEqual([]);
    expect(() => loadWorkflow(bad)).toThrow(
      /invalid workflow:\noptOut\.keepStates: "NOPE" is not a state/
    );
  });
  it('rejects a value that is not an object', () => {
    expect(() => loadWorkflow(null)).toThrow(/invalid workflow/);
    expect(() => loadWorkflow('{}')).toThrow(/invalid workflow/);
  });
});
