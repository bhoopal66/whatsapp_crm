/**
 * A report is only shown under the filter it was fetched for. When a filter
 * change fails to load, the previous figures would otherwise stay on screen
 * at full strength under the newly selected agent or period, with only a
 * banner to say something went wrong.
 */
export function shownReport<T extends { key: string }>(
  loaded: T | null,
  currentKey: string
): T | null {
  return loaded && loaded.key === currentKey ? loaded : null;
}
