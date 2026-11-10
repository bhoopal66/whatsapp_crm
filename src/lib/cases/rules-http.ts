/**
 * Refusal -> HTTP for the case-rules routes (`/api/cases/rules*`,
 * `/api/cases/[id]/rule-runs`, migration 187). Refusals answer
 * `{ error, code }`; store failures and anything unknown go through
 * `caseErrorResponse` (logged by function and SQLSTATE only). SQL text
 * never reaches the client.
 */
import { NextResponse } from 'next/server';

import { caseErrorResponse } from './http';
import { CaseRulesRefusedError, type CaseRuleRefusal } from './rules';

export const CASE_RULES_REFUSAL_HTTP: Readonly<
  Record<CaseRuleRefusal, { status: number; text: string }>
> = {
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  RULE_NOT_FOUND: { status: 404, text: 'Rule not found' },
  CASE_NOT_FOUND: { status: 404, text: 'Case not found' },
  RULE_INVALID: { status: 422, text: 'That rule is not valid' },
  NOW_REQUIRED: { status: 422, text: 'A time is required' },
};

export function caseRulesErrorResponse(err: unknown): NextResponse {
  if (err instanceof CaseRulesRefusedError) {
    const { status, text } = CASE_RULES_REFUSAL_HTTP[err.reason];
    return NextResponse.json({ error: text, code: err.reason }, { status });
  }
  return caseErrorResponse(err, 'rules');
}
