import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { ValidationIssue } from './validate';
import { resolveTemplateValues } from './template-values';

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

/**
 * The `send_template` steps, branches included, whose template has a
 * placeholder the step gives no value. A template that cannot be read or
 * found is left to the run, which refuses it. Paths as validate.ts's.
 */
export async function templateValueIssues(
  db: SupabaseClient,
  accountId: string,
  steps: StepLike[],
  prefix = ''
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const [i, step] of (Array.isArray(steps) ? steps : []).entries()) {
    const path = `${prefix}steps[${i}]`;
    const c = step.step_config ?? {};
    if (step.step_type === 'send_template' && c.template_name) {
      const { row } = await resolveTemplateRow(
        db,
        accountId,
        String(c.template_name),
        c.language as string | undefined
      );
      const missing = row ? resolveTemplateValues(row, c).missing : [];
      if (missing.length > 0) {
        issues.push({
          path: `${path}.variables`,
          message: `template value is required for ${missing.join(', ')}`,
        });
      }
    }
    for (const side of ['yes', 'no'] as const) {
      const child = step.branches?.[side];
      if (child) {
        issues.push(
          ...(await templateValueIssues(
            db,
            accountId,
            child,
            `${path}.${side}.`
          ))
        );
      }
    }
  }
  return issues;
}
