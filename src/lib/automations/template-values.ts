import {
  compareVariableKeys,
  extractVariableKeys,
} from '@/lib/whatsapp/template-validators';

/** The parts of a template that take values in an automation. */
export interface TemplateText {
  body_text: string;
  header_type?: string | null;
  header_content?: string | null;
}

/** What a saved `send_template` step holds. */
export interface TemplateStepValues {
  variables?: Record<string, string>;
  header_text?: string;
}

export interface TemplateValues {
  /** Body values in the order a send lists them. */
  params: string[];
  headerText?: string;
  /** Placeholders with no value, as written: `{{1}}`, `header {{1}}`. */
  missing: string[];
}

/** Whether the template's text header has a placeholder of its own. */
export function headerTakesValue(template: TemplateText): boolean {
  return (
    template.header_type === 'text' &&
    extractVariableKeys(template.header_content ?? '').length > 0
  );
}

/**
 * The values a send of `template` uses, and which are missing. `fill`
 * resolves the step's own `{{ vars.x }}`; a value that comes out empty is
 * missing, or the customer reads a literal `{{1}}`.
 */
export function resolveTemplateValues(
  template: TemplateText,
  step: TemplateStepValues,
  fill: (value: string) => string = (value) => value
): TemplateValues {
  const saved = step.variables ?? {};
  const savedKeys = Object.keys(saved).sort(compareVariableKeys);
  const keys = extractVariableKeys(template.body_text);
  // Values saved under other names (not by the builder) go by position,
  // as they always have.
  const named = keys.some((k) => k in saved);
  const params: string[] = [];
  const missing: string[] = [];
  keys.forEach((key, i) => {
    const raw = saved[named ? key : savedKeys[i]];
    const value = raw == null ? '' : fill(String(raw));
    // renderTemplateBody reads `{{N}}` at N - 1 and a name at its rank.
    params[/^\d+$/.test(key) ? Number(key) - 1 : i] = value;
    if (!value.trim()) missing.push(`{{${key}}}`);
  });
  const headerText = step.header_text ? fill(step.header_text) : undefined;
  if (headerTakesValue(template) && !headerText?.trim()) {
    missing.push(`header ${extractVariableKeys(template.header_content!).map((k) => `{{${k}}}`)[0]}`);
  }
  return {
    params: Array.from(params, (v) => v ?? ''),
    ...(headerTakesValue(template) && headerText ? { headerText } : {}),
    missing,
  };
}
