/**
 * What the conversation list's body shows. An empty list after a failed
 * read says nothing about the chats, so it is never "No conversations":
 * it is an error with Retry. Rows in hand stay up whatever failed.
 *
 * `failedView` is the view whose last first-page read failed (null once
 * a page arrives), `view` the one on screen: a failure left over from
 * another view means this one's first read is still on its way.
 */
export type ListBody = 'loading' | 'rows' | 'error' | 'empty';

export function conversationListBody<V extends object>(list: {
  loading: boolean;
  rowCount: number;
  failedView: V | null;
  view: V;
}): ListBody {
  if (list.loading) return 'loading';
  if (list.rowCount > 0) return 'rows';
  if (list.failedView === list.view) return 'error';
  if (list.failedView !== null) return 'loading';
  return 'empty';
}

/**
 * The list's foot: nothing, the infinite scroll's sentinel, or a "could
 * not load more" row with Retry. It stays away from an error body, whose
 * cursor is another view's.
 */
export type ListFoot = 'none' | 'sentinel' | 'error';

export function conversationListFoot<V extends object>(list: {
  body: ListBody;
  hasMore: boolean;
  loadingMore: boolean;
  /** The view whose last further page failed; null once one arrives. */
  failedPageView: V | null;
  view: V;
}): ListFoot {
  if (!list.hasMore || list.body === 'loading' || list.body === 'error') {
    return 'none';
  }
  return !list.loadingMore && list.failedPageView === list.view
    ? 'error'
    : 'sentinel';
}
