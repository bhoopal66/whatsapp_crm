/**
 * The decisions the HR panel in a chat makes (`components/hr/hr-panel`),
 * pure so they are testable without a DOM. They only decide what the
 * panel offers: every write is an `hr_*` RPC that re-checks the caller
 * and the chat's visibility (migration 200).
 */
import {
  canMoveBackward,
  canReopen,
  canWrite,
  hasHrAccess,
  isBackwardMove,
  stageIndex,
} from './access';
import {
  HR_STAGES,
  type HrConversation,
  type HrOpenKind,
  type HrOutcome,
  type HrRoles,
  type HrStage,
} from './types';

/**
 * Whether the panel shows at all: the viewer holds an HR role, and the
 * chat is in the HR department's inbox (migration 192) or already has
 * an HR row (it may have been tracked before it moved).
 */
export function showHrPanel(
  roles: HrRoles | null,
  inboxDepartment: string | null | undefined,
  hasRow: boolean
): boolean {
  if (!roles || !hasHrAccess(roles)) return false;
  return inboxDepartment === 'hr' || hasRow;
}

/** "Track in HR as": only the kinds whose target inbox the viewer writes. */
export function openKinds(roles: HrRoles): HrOpenKind[] {
  const kinds: HrOpenKind[] = [];
  if (canWrite(roles, 'recruiter')) kinds.push('candidate');
  if (canWrite(roles, 'dept')) kinds.push('employee');
  return kinds;
}

/** The later of two stages (by position); unknown stages are ignored. */
export function laterStage(
  a: string | null | undefined,
  b: string | null | undefined
): HrStage | null {
  const ia = stageIndex(a);
  const ib = stageIndex(b);
  const best = Math.max(ia, ib);
  return best < 0 ? null : HR_STAGES[best];
}

/** The furthest stage ever reached, from `hr_stage_history` rows. */
export function furthestStage(
  rows: ReadonlyArray<{ to_stage: string | null }> | null | undefined
): HrStage | null {
  let furthest: HrStage | null = null;
  for (const row of rows ?? []) furthest = laterStage(furthest, row.to_stage);
  return furthest;
}

/** Whether the viewer may change the row at all (open and theirs to write). */
export function canEditRow(row: HrConversation, roles: HrRoles): boolean {
  return row.closed_at === null && canWrite(roles, row.inbox);
}

export type StepProgress = 'done' | 'current' | 'todo';
/**
 * What clicking a step does: `forward` moves at once, `backward` asks
 * for a reason first, `locked` is a backward step this viewer may not
 * take, `none` is the current step or a read-only panel.
 */
export type StepMove = 'forward' | 'backward' | 'locked' | 'none';

export interface StepState {
  stage: HrStage;
  progress: StepProgress;
  move: StepMove;
}

/** True when clicking the step asks for a reason before moving. */
export function stepNeedsReason(step: StepState): boolean {
  return step.move === 'backward';
}

/**
 * The 4-step stepper. On a recruiter row it shows progress and moves
 * the stage; on a dept row it is the "Move to recruitment" picker, where
 * a stage before the furthest ever reached is a backward move (the 023b
 * loophole). A closed row or one the viewer cannot write is display only.
 */
export function stepperSteps(
  row: HrConversation,
  roles: HrRoles,
  furthest: string | null
): StepState[] {
  const editable = canEditRow(row, roles);
  const current = row.inbox === 'recruiter' ? stageIndex(row.stage_key) : -1;
  return HR_STAGES.map((stage, i) => {
    const progress: StepProgress =
      current < 0
        ? 'todo'
        : i < current
          ? 'done'
          : i === current
            ? 'current'
            : 'todo';
    let move: StepMove = 'none';
    if (editable && i !== current) {
      if (isBackwardMove(row.inbox, row.stage_key, stage, furthest)) {
        move = canMoveBackward(roles) ? 'backward' : 'locked';
      } else {
        move = 'forward';
      }
    }
    return { stage, progress, move };
  });
}

export interface PanelActions {
  /** Stage/topic/flag writes and close. */
  edit: boolean;
  /** The recruiter stepper (progress + moves). */
  stepper: boolean;
  /** The dept topic select. */
  topic: boolean;
  /** Close needs one of the outcomes (recruiter) or none (dept). */
  close: false | { needsOutcome: boolean };
  /** Reopen (asks for a reason). */
  reopen: boolean;
  /** "Move to HR department" (topic picker), from recruiter. */
  moveToDept: boolean;
  /** "Move to recruitment" (stage picker), from dept. */
  moveToRecruitment: boolean;
}

/** Which controls the panel offers for this row and viewer. */
export function panelActions(
  row: HrConversation,
  roles: HrRoles
): PanelActions {
  const edit = canEditRow(row, roles);
  const recruiter = row.inbox === 'recruiter';
  return {
    edit,
    stepper: recruiter,
    topic: !recruiter,
    close: edit ? { needsOutcome: recruiter } : false,
    reopen: row.closed_at !== null && canReopen(roles, row.inbox),
    moveToDept: edit && recruiter,
    moveToRecruitment: edit && !recruiter,
  };
}

/**
 * The outcome a close carries: only a recruitment row takes one (the
 * server answers INVALID for an outcome on a department row), so a
 * stale pick is never sent for any other.
 */
export function outcomeToSend(
  row: { inbox: string },
  selected: HrOutcome | ''
): HrOutcome | null {
  return row.inbox === 'recruiter' && selected !== '' ? selected : null;
}

/** A non-blank reason (what NEEDS_REASON checks with `^[[:space:]]*$`). */
export function hasReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && /\S/u.test(reason);
}
