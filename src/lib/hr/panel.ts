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
  hrRoleFor,
  isBackwardMove,
  stageIndex,
} from './access';
import {
  HR_OUTCOMES,
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
 * Whether the pane offers the Interview field (339): a recruitment chat
 * the viewer may edit, which also means it is open. A department chat
 * never has one (the RPC answers INVALID), and a viewer who may not
 * write gets no read-only copy of it.
 */
export function showInterviewField(
  row: HrConversation,
  actions: PanelActions
): boolean {
  return paneKind(row) === 'recruiter' && actions.edit;
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

/** Which "Conversation" pane the chat gets: not yet tracked, or its inbox. */
export type PaneKind = 'unsorted' | 'recruiter' | 'dept';

export function paneKind(row: { inbox: string } | null): PaneKind {
  if (!row) return 'unsorted';
  return row.inbox === 'dept' ? 'dept' : 'recruiter';
}

export type PaneSection = 'stage' | 'topic' | 'flags' | 'reply' | 'close';

/**
 * The fieldsets of a tracked chat's pane, top to bottom (the package's
 * "Conversation" pane). A recruitment chat leads with its stage and
 * offers a topic only as the move to the HR department; a department
 * chat leads with its topic and offers the stage only as the move to
 * recruitment. A move the viewer may not make is left out; Close shows
 * while the viewer may close or the chat is closed (Closed + Reopen).
 */
export function paneSections(
  row: HrConversation,
  actions: PanelActions
): PaneSection[] {
  const closeShown = actions.close !== false || row.closed_at !== null;
  const order: [PaneSection, boolean][] =
    paneKind(row) === 'dept'
      ? [
          ['topic', actions.topic],
          ['stage', actions.moveToRecruitment],
          ['flags', true],
          ['reply', true],
          ['close', closeShown],
        ]
      : [
          ['stage', actions.stepper],
          ['topic', actions.moveToDept],
          ['flags', true],
          ['reply', true],
          ['close', closeShown],
        ];
  return order.filter(([, shown]) => shown).map(([s]) => s);
}

/**
 * The hint under a section that moves the chat to the other inbox: the
 * topic on a recruitment chat, the stage on a department chat. An `Hr`
 * message key, or null when the section moves nothing.
 */
export function paneMoveHintKey(
  kind: PaneKind,
  section: PaneSection
): string | null {
  if (kind === 'recruiter' && section === 'topic') return 'pane.movesToDept';
  if (kind === 'dept' && section === 'stage') return 'pane.movesToRecruiter';
  return null;
}

/** One button in the Close fieldset; `outcome` null closes without one. */
export interface CloseChoice {
  outcome: HrOutcome | null;
  /** `Hr` message key of the button. */
  labelKey: string;
  /** `Hr` message key of the confirm question (takes `{outcome}`). */
  confirmKey: string;
}

/**
 * A recruitment chat closes with one of its outcomes, one button each;
 * a department chat has a single "Close conversation". Every close asks
 * first, because undoing it (Reopen) needs a reason.
 */
export function closeChoices(row: { inbox: string }): CloseChoice[] {
  if (row.inbox !== 'recruiter') {
    return [
      {
        outcome: null,
        labelKey: 'pane.closeConversation',
        confirmKey: 'pane.closeConfirm',
      },
    ];
  }
  return HR_OUTCOMES.map((outcome) => ({
    outcome,
    labelKey: `outcome.${outcome}`,
    confirmKey: 'pane.closeAs',
  }));
}

/**
 * What the pane's Owner control offers (the package's rule, layered on
 * the inbox header's `assignableMembers` list, which already leaves out
 * whom the assignment triggers would refuse). `null` = the name only.
 */
export interface HrOwnerChoices {
  /** People to offer, in `assignable` order (current owner included). */
  userIds: string[];
  /** Whether "Unassigned" is offered. */
  unassigned: boolean;
}

/**
 * - an admin/owner or the inbox's HR lead: anyone assignable who is on
 *   that inbox's HR team, plus the current owner, or Unassigned. With
 *   no HR team configured the assignable list stands, so it is never
 *   empty;
 * - an HR member: claim an unowned chat, or release their own (self and
 *   Unassigned); someone else's chat shows the name only;
 * - anyone else: the name only.
 */
export function hrOwnerChoices({
  roles,
  inbox,
  myUserId,
  ownerId,
  assignable,
  teamUserIds,
}: {
  roles: HrRoles;
  inbox: HrConversation['inbox'];
  myUserId: string | null | undefined;
  ownerId: string | null;
  /** `assignableMembers(...)` user ids. */
  assignable: readonly string[];
  /**
   * `hr_team_members` of this inbox; null while it is not read yet (or
   * the read failed). Unknown never widens the list: until the team is
   * known a lead or admin is offered only the current owner and
   * Unassigned. A known EMPTY team means none is set up, and then the
   * assignable list is used.
   */
  teamUserIds: ReadonlySet<string> | null;
}): HrOwnerChoices | null {
  const role = hrRoleFor(roles, inbox);
  if (role === 'admin' || role === 'lead') {
    const team =
      teamUserIds === null
        ? []
        : teamUserIds.size > 0
          ? assignable.filter((id) => teamUserIds.has(id))
          : [...assignable];
    if (ownerId && !team.includes(ownerId)) team.unshift(ownerId);
    return { userIds: team, unassigned: true };
  }
  if (role === 'member' && myUserId) {
    if (ownerId !== null && ownerId !== myUserId) return null;
    return { userIds: [myUserId], unassigned: true };
  }
  return null;
}
