/**
 * Who writes `document.title`. Two writers share the tab title: the
 * unread title (`TabTitle` in the dashboard shell) and the reminder
 * alarm's flash (`useFlashingTitle` in reminder-alarm.tsx). Without a
 * referee each would overwrite the other: the alarm restored a title it
 * had saved before the flash (stale once the count moved), and the
 * unread updater (and its observer, which re-applies the title after
 * Next's metadata resets it) would undo every flash tick.
 *
 * The rule: the unread updater only *proposes* a base title
 * (`setBase`); it is written at once unless a flash is running. While
 * the alarm flashes (`beginFlash` … `endFlash`) it alone writes, and its
 * even ticks show the current base (`base()`), so a count that changes
 * mid-flash still shows. `endFlash` writes the current base back, not
 * the title the flash started from.
 */

export interface TitleTarget {
  title: string;
}

export class TitleOwner {
  private baseTitle: string | null = null;
  private flashing = 0;

  constructor(private readonly target: () => TitleTarget | null) {}

  /** The title the tab shows when nothing is flashing. */
  base(): string {
    return this.baseTitle ?? this.target()?.title ?? '';
  }

  isFlashing(): boolean {
    return this.flashing > 0;
  }

  /**
   * The unread updater's title. Written unless a flash runs (then it is
   * kept for the flash's even ticks and its end). `null` withdraws it
   * (the shell unmounted); the tab keeps what it shows.
   */
  setBase(title: string | null): void {
    this.baseTitle = title;
    if (title !== null && !this.isFlashing()) this.write(title);
  }

  /**
   * Re-writes the base title if something else changed the tab's title
   * (Next resets it from metadata on navigation). A no-op while
   * flashing, or when the title is already right, so an observer that
   * calls this on every title change cannot loop.
   */
  reassert(): void {
    if (this.baseTitle === null || this.isFlashing()) return;
    this.write(this.baseTitle);
  }

  /** The alarm starts flashing; returns the base it flashes against. */
  beginFlash(): string {
    // With no unread updater mounted, the tab's own title is the base
    // the flash shows and restores.
    if (this.baseTitle === null) this.baseTitle = this.target()?.title ?? '';
    this.flashing += 1;
    return this.baseTitle;
  }

  /** A flash tick: written only while a flash is running. */
  flashWrite(title: string): void {
    if (this.isFlashing()) this.write(title);
  }

  /** The flash ends: the current base goes back on the tab. */
  endFlash(): void {
    if (this.flashing === 0) return;
    this.flashing -= 1;
    if (!this.isFlashing()) this.write(this.base());
  }

  private write(title: string): void {
    const target = this.target();
    if (target && target.title !== title) target.title = title;
  }
}

/** The tab's one referee, shared by the unread title and the alarm. */
export const tabTitle = new TitleOwner(() =>
  typeof document === 'undefined' ? null : document
);
