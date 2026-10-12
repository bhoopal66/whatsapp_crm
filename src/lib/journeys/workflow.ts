/**
 * The shipped "Welcome to Close" workflow and a validating loader. The JSON is
 * imported statically (no fs), so the engine can run inside Next route handlers.
 */
import workflowJson from './workflows/taamul-welcome-to-close.v1.json';
import { validateWorkflow, type WorkflowDef } from './schema';

/**
 * The shipped workflow, typed but not validated at import: the behaviour tests
 * run it raw so a bad JSON shows up as wrong behaviour, and validator.test.ts
 * asserts it validates clean.
 */
export const SHIPPED_WORKFLOW = workflowJson as unknown as WorkflowDef;

/**
 * Validates a workflow definition from an untrusted source (JSON from a
 * database or a request) and returns it typed. Throws, listing every
 * validateWorkflow error, when it is not valid.
 */
export function loadWorkflow(def: unknown): WorkflowDef {
  if (typeof def !== 'object' || def === null)
    throw new Error('invalid workflow: expected an object');
  const errors = validateWorkflow(def as WorkflowDef);
  if (errors.length) throw new Error(`invalid workflow:\n${errors.join('\n')}`);
  return def as WorkflowDef;
}
