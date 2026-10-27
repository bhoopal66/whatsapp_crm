'use client';

import { createContext, useContext } from 'react';

/**
 * Lets the detail pane tell the list (which lives in the layout and
 * never remounts) that a row changed. Without a provider it is a no-op,
 * so the detail still renders on its own.
 */
export interface SubmissionGroupsListContextValue {
  /** Re-read the current tab and search from the first page. */
  refreshList: () => void;
  /** The list hands over its reload; returns the unregister function. */
  registerRefresh: (fn: () => void) => () => void;
}

export const SubmissionGroupsListContext =
  createContext<SubmissionGroupsListContextValue>({
    refreshList: () => {},
    registerRefresh: () => () => {},
  });

export function useSubmissionGroupsList() {
  return useContext(SubmissionGroupsListContext);
}
