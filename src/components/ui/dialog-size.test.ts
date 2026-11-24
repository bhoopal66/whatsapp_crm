import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// A dialog is centred with a transform, so one taller than the window is
// cut off above and below and cannot be scrolled: on a 1366x768 laptop the
// template picker's Send button was below the screen, and "some staff"
// could not send templates (2026-11-24). shadcn's own file has no limit;
// regenerating it must not lose this one.
it('a dialog is never taller than the window, and scrolls', () => {
  const src = readFileSync(
    join(process.cwd(), 'src/components/ui/dialog.tsx'),
    'utf8'
  );
  const popup = src.slice(src.indexOf('<DialogPrimitive.Popup'));
  expect(popup).toContain('max-h-[calc(100dvh-2rem)]');
  expect(popup).toContain('overflow-y-auto');
});

it("the template picker's buttons stay while its middle scrolls", () => {
  const src = readFileSync(
    join(process.cwd(), 'src/components/inbox/template-picker.tsx'),
    'utf8'
  );
  expect(src).toMatch(
    /<DialogContent className="[^"]*flex flex-col overflow-hidden/
  );
  expect(src.match(/min-h-0 flex-1 [^"]*overflow-y-auto/g)).toHaveLength(2);
  expect(src).toMatch(/<DialogFooter className="shrink-0/);
  // A tap outside keeps what was filled in.
  expect(src).toContain('disablePointerDismissal={selected !== null}');
});
