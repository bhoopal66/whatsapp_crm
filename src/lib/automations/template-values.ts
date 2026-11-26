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

/** What a saved `send_template` step holds: JSON, so `variables` may be
 *  any shape a step written elsewhere gave it. */
export interface TemplateStepValues {
  variables?: unknown;
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
 * The step's value for every placeholder of the body, '' where it has
 * none. The builder saves placeholder keys; a step from elsewhere may
 * hold an array or other keys, which go by position, as they always have.
 */
export function valuesByPlaceholder(
  template: TemplateText,
  step: TemplateStepValues
): Record<string, string> {
  const keys = extractVariableKeys(template.body_text);
  const saved: Record<string, unknown> =
    step.variables && typeof step.variables === 'object'
      ? { ...step.variables }
      : {};
  const savedKeys = Object.keys(saved).sort(compareVariableKeys);
  // Placeholder keys alone are the builder's, half filled in or not: their
  // names hold, or a value typed for {{2}} would move to {{1}}.
  const named =
    !Array.isArray(step.variables) &&
    (keys.every((k) => savedKeys.includes(k)) ||
      savedKeys.every((k) => keys.includes(k)));
  return Object.fromEntries(
    keys.map((key, i) => {
      const raw = saved[named ? key : savedKeys[i]];
      return [key, raw == null ? '' : String(raw)];
    })
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
  const values = valuesByPlaceholder(template, step);
  const keys = extractVariableKeys(template.body_text);
  const params: string[] = [];
  const missing: string[] = [];
  keys.forEach((key, i) => {
    const value = fill(values[key]);
    // renderTemplateBody reads `{{N}}` at N - 1 and a name at its rank.
    params[/^\d+$/.test(key) ? Number(key) - 1 : i] = value;
    if (!value.trim()) missing.push(`{{${key}}}`);
  });
  const headerText = step.header_text
    ? fill(String(step.header_text))
    : undefined;
  if (headerTakesValue(template) && !headerText?.trim()) {
    missing.push(
      `header ${extractVariableKeys(template.header_content!).map((k) => `{{${k}}}`)[0]}`
    );
  }
  return {
    params: Array.from(params, (v) => v ?? ''),
    ...(headerTakesValue(template) && headerText ? { headerText } : {}),
    missing,
  };
}
