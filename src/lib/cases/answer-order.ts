/**
 * Overlapping reads of one resource, in the order they were asked. An
 * older answer never overwrites a newer one; a newer read that failed
 * does not throw an older answer away. Pure.
 */
export class AnswerOrder {
  private asked = 0;
  private shown = 0;

  /** A read begins; pass the number back to `accept` / `isStale`. */
  start(): number {
    return ++this.asked;
  }

  /** A newer answer is already shown. */
  isStale(read: number): boolean {
    return read < this.shown;
  }

  /** Whether this answer may be shown; if so it is now the shown one. */
  accept(read: number): boolean {
    if (this.isStale(read)) return false;
    this.shown = read;
    return true;
  }
}
