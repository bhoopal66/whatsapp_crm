/**
 * The managers editor's set, on both sides of the PUT. The tab says which
 * set it loaded (`base`), so what it sends is a change, not a replacement:
 * a colleague added to the group since is in neither list and stays.
 */

export interface LoadedManager {
  userId: string;
  isCreator: boolean;
}

/** The set the picker started from; the creator is never in it. */
export function baseManagers(managers: readonly LoadedManager[]): string[] {
  return managers.filter((x) => !x.isCreator).map((x) => x.userId);
}

/** Whether the picker's selection differs from what was loaded. */
export function managersEdited(
  managers: readonly LoadedManager[],
  selected: readonly string[]
): boolean {
  return (
    selected.length !== baseManagers(managers).length ||
    selected.some((id) => !managers.some((x) => x.userId === id))
  );
}

export function managerSaveBody(
  managers: readonly LoadedManager[],
  selected: readonly string[]
): { userIds: string[]; base: string[] } {
  return { userIds: [...selected], base: baseManagers(managers) };
}

/**
 * The whole set the PUT should leave: `userIds` itself without a `base`
 * (a tab from before it existed), else the stored managers less
 * `base − userIds` plus `userIds − base`.
 */
export function wantedManagers(args: {
  before: readonly string[];
  userIds: readonly string[];
  base?: readonly string[];
}): string[] {
  if (!args.base) return [...new Set(args.userIds)];
  const base = new Set(args.base);
  const sent = new Set(args.userIds);
  return [
    ...new Set([
      ...args.before.filter((u) => sent.has(u) || !base.has(u)),
      ...args.userIds.filter((u) => !base.has(u)),
    ]),
  ];
}
