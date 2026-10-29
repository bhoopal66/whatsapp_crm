// ============================================================
// Meaning triggers: the config a Flow `intent` trigger and an
// automation `intent_match` trigger share, its validation, and the
// sensitivity → threshold mapping. Pure (no I/O), so the builders can
// import it too.
// ============================================================

export type MeaningSensitivity = 'strict' | 'balanced' | 'loose';

export interface IntentTriggerConfig {
  /** What the customer means, in the admin's words (10–300 chars). */
  description: string;
  /** Up to 5 example messages, each ≤ 120 chars. */
  examples?: string[];
  /** Default 'balanced'. */
  sensitivity?: MeaningSensitivity;
}

export const MEANING_DESCRIPTION_MIN_CHARS = 10;
export const MEANING_DESCRIPTION_MAX_CHARS = 300;
export const MEANING_MAX_EXAMPLES = 5;
export const MEANING_EXAMPLE_MAX_CHARS = 120;

/**
 * P(the message means it) a trigger needs to fire. UNCALIBRATED: picked
 * by judgment, not measured against labelled traffic. Revisit once real
 * judgments have been reviewed.
 */
export const MEANING_THRESHOLDS: Record<MeaningSensitivity, number> = {
  strict: 0.85,
  balanced: 0.75,
  loose: 0.65,
};

export function meaningThreshold(s: unknown): number {
  return s === 'strict' || s === 'loose'
    ? MEANING_THRESHOLDS[s]
    : MEANING_THRESHOLDS.balanced;
}

export interface MeaningConfigIssue {
  /** `description`, `examples`, `examples.N` or `sensitivity`. */
  field: string;
  message: string;
}

/** Problems with a stored intent trigger config; empty when valid. */
export function validateIntentTriggerConfig(
  raw: unknown
): MeaningConfigIssue[] {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const issues: MeaningConfigIssue[] = [];
  const d = typeof cfg.description === 'string' ? cfg.description.trim() : '';
  if (
    d.length < MEANING_DESCRIPTION_MIN_CHARS ||
    d.length > MEANING_DESCRIPTION_MAX_CHARS
  ) {
    issues.push({
      field: 'description',
      message: `Describe what the customer means in ${MEANING_DESCRIPTION_MIN_CHARS}–${MEANING_DESCRIPTION_MAX_CHARS} characters.`,
    });
  }
  if (cfg.examples != null) {
    if (!Array.isArray(cfg.examples)) {
      issues.push({ field: 'examples', message: 'Examples must be a list.' });
    } else {
      if (cfg.examples.length > MEANING_MAX_EXAMPLES) {
        issues.push({
          field: 'examples',
          message: `At most ${MEANING_MAX_EXAMPLES} examples.`,
        });
      }
      cfg.examples.forEach((e, i) => {
        if (
          typeof e !== 'string' ||
          !e.trim() ||
          e.trim().length > MEANING_EXAMPLE_MAX_CHARS
        ) {
          issues.push({
            field: `examples.${i}`,
            message: `Each example needs 1–${MEANING_EXAMPLE_MAX_CHARS} characters.`,
          });
        }
      });
    }
  }
  if (
    cfg.sensitivity != null &&
    cfg.sensitivity !== 'strict' &&
    cfg.sensitivity !== 'balanced' &&
    cfg.sensitivity !== 'loose'
  ) {
    issues.push({
      field: 'sensitivity',
      message: 'Sensitivity must be "strict", "balanced" or "loose".',
    });
  }
  return issues;
}

const SUMMARY_MAX_CHARS = 60;

/** The description as the flows/automations lists show it: trimmed,
 *  whitespace collapsed, clipped with an ellipsis. Empty when unset. */
export function meaningTriggerSummary(raw: unknown): string {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const d =
    typeof cfg.description === 'string'
      ? cfg.description.replace(/\s+/g, ' ').trim()
      : '';
  return d.length > SUMMARY_MAX_CHARS
    ? `${d.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
    : d;
}
