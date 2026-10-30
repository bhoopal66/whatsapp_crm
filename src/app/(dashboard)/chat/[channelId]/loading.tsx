/**
 * The channel's placeholder while its route loads. Without it the
 * prefetch of /chat/<id> stops at the dashboard's generic boundary and
 * a click sits on the previous channel for a round trip. The sidebar
 * stays (it is the chat layout's), and the rows mirror the timeline's
 * own skeleton (message-timeline.tsx) so the swap does not jump.
 */
export default function Loading() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <div className="bg-muted h-4 w-40 animate-pulse rounded" />
      </div>
      <div className="flex-1 space-y-4 overflow-hidden p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="bg-muted size-9 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-3 w-40 animate-pulse rounded" />
              <div className="bg-muted h-3 w-3/4 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
