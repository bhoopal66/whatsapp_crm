/**
 * Pure helpers for the record menus (contacts, cases, deals, banks) of
 * the app-wide right-click menu.
 */

export interface StageLike {
  id: string;
  name: string;
  position: number;
}

/**
 * The stages a deal card's "Move to stage" submenu offers: the board's
 * stages in board order, minus the one the deal is already in. None when
 * the board is read-only, as the board then refuses a drag too.
 */
export function moveTargets<S extends StageLike>(
  stages: readonly S[],
  currentStageId: string,
  readOnly: boolean
): S[] {
  if (readOnly) return [];
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .filter((s) => s.id !== currentStageId);
}
