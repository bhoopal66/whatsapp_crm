import { Skeleton } from '@/components/dashboard/skeleton';

/**
 * Navigation placeholder for every dashboard screen.
 *
 * Two reasons it exists, both about how a tunnelled self-host feels:
 *
 *   1. The role-gated routes read cookies in their layout guard, which
 *      makes them dynamic. Next does not prefetch a dynamic route
 *      *unless it has a loading boundary* — with one, the shell up to
 *      this boundary is prefetched, so the click lands on something
 *      immediately instead of waiting out a round trip first.
 *   2. Without a boundary the browser sits on the previous screen for
 *      the whole of that round trip, which reads as "the click did
 *      nothing" rather than "this is loading".
 *
 * Deliberately generic: it stands in for a list, a board and a form
 * alike, so it must not promise a shape the arriving screen won't have.
 */
export default function Loading() {
  return (
    <div className="animate-in fade-in-50 duration-200" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-6 space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
