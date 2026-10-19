// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18. "workspace" here means the wacrm
// account id (uuid).
/**
 * Tool risk registry and the confirmation rule.
 *   READ      never needs confirmation.
 *   WRITE     needs confirmation in 'supervised' only.
 *   DANGEROUS needs confirmation in EVERY mode (supervised, cautious, autonomous). No mode, flag or argument relaxes it.
 * A tool missing from the registry is treated as DANGEROUS (fail closed).
 */
export type RiskLevel = 'READ' | 'WRITE' | 'DANGEROUS';
export type AutonomyMode = 'supervised' | 'cautious' | 'autonomous';
export const AUTONOMY_MODES: readonly AutonomyMode[] = [
  'supervised',
  'cautious',
  'autonomous',
];
export const DEFAULT_MODE: AutonomyMode = 'cautious';

/** Default wacrm assistant tools. Applications pass their own map to ToolRegistry. */
export const DEFAULT_TOOL_RISKS: Readonly<Record<string, RiskLevel>> = {
  search_contacts: 'READ',
  get_contact: 'READ',
  list_groups: 'READ',
  update_contact: 'WRITE',
  add_note: 'WRITE',
  send_message: 'WRITE',
  delete_contact: 'DANGEROUS',
  bulk_send: 'DANGEROUS',
  change_role: 'DANGEROUS',
  export_contacts: 'DANGEROUS',
  end_group: 'DANGEROUS',
};

/** A tool's registry entry. A bare RiskLevel is shorthand for { risk }. */
export interface ToolSpec {
  readonly risk: RiskLevel;
  /** Shown to the human in the confirmation prompt (default: the registry key). */
  readonly displayName?: string;
  /** Renders args for the human prompt as [label, value] pairs (still sanitized, truncated and capped). */
  readonly describeArgs?: (
    args: unknown
  ) => ReadonlyArray<readonly [string, string]>;
  /** What the loop guard compares for LOOP_REPEAT (default: the full canonical args), e.g. to ignore a request id. */
  readonly loopKey?: (args: unknown) => unknown;
}

export interface ResolvedToolSpec extends ToolSpec {
  readonly registered: boolean;
  readonly displayName: string;
}

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, ToolSpec>;
  constructor(
    tools: Readonly<Record<string, RiskLevel | ToolSpec>> = DEFAULT_TOOL_RISKS
  ) {
    this.tools = new Map(
      Object.entries(tools).map(([k, v]) => [
        k,
        typeof v === 'string' ? { risk: v } : v,
      ])
    );
  }
  risk(tool: string): RiskLevel {
    return this.tools.get(tool)?.risk ?? 'DANGEROUS';
  }
  spec(tool: string): ResolvedToolSpec {
    const t = this.tools.get(tool);
    if (!t)
      return {
        risk: 'DANGEROUS',
        registered: false,
        displayName: 'unregistered tool',
      };
    return { ...t, registered: true, displayName: t.displayName ?? tool };
  }
}

export function needsConfirmation(
  risk: RiskLevel,
  mode: AutonomyMode
): boolean {
  if (risk === 'DANGEROUS') return true;
  if (risk === 'WRITE') return mode === 'supervised';
  return false;
}
