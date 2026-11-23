'use client';

/**
 * My worklist (package 029c): what needs action next, ranked in the
 * browser from reads other screens already make (`loadWorklistInputs`,
 * which never throws and names the parts it could not read). There is no worklist API and nothing here
 * writes; each row opens its existing screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { ErrorState } from '@/components/dashboard/error-state';
import { DeskWorklistCard } from '@/components/desk/desk-worklist-card';
import { WaitingCustomers } from '@/components/worklist/waiting-customers';
import {
  WORKLIST_MY_TEAM,
  WorklistView,
} from '@/components/worklist/worklist-view';
import { useAuth } from '@/hooks/use-auth';
import { useLedTeam } from '@/hooks/use-led-team';
import { createClient } from '@/lib/supabase/client';
import { loadWorklistInputs } from '@/lib/worklist/load';
import {
  mergeWorklistLoad,
  type WorklistLoad,
} from '@/lib/worklist/load-state';
import {
  filterWaitingChats,
  loadWaitingChats,
  WAITING_CHATS_LIMIT,
  type WaitingChat,
} from '@/lib/worklist/waiting';
import { rankWorklist, worklistMode } from '@/lib/worklist/rank';

/** How often the waiting customers are re-read while the page is open. */
const WAITING_REFRESH_MS = 60_000;

export default function WorklistPage() {
  const tWaiting = useTranslations('WorklistWaiting');
  const { user, accountId, accountRole, salesRestricted } = useAuth();
  const { members, nameOf } = useWorkspaceMembers();
  const team = useLedTeam();
  // Both are tagged with the workspace they belong to, so a workspace
  // switch shows loading and Anyone again without resetting state in an
  // effect. Ranked against the moment the reads were made.
  const [loaded, setLoaded] = useState<{
    accountId: string;
    load: WorklistLoad;
    now: number;
    attempt: number;
  } | null>(null);
  // Bumped by Retry; until a load carries the same number, it is on its way.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Customers waiting for a reply (migration 238), tagged like `loaded`.
  // `rows` null: never had a good read; a failed refresh keeps the last.
  const [waiting, setWaiting] = useState<{
    accountId: string;
    rows: WaitingChat[] | null;
    now: number;
    failed: boolean;
    attempt: number;
  } | null>(null);
  const [waitingAttempt, setWaitingAttempt] = useState(0);
  const retryWaiting = useCallback(() => setWaitingAttempt((n) => n + 1), []);
  const [filter, setFilter] = useState({ accountId, userId: '' });
  const assignedTo = filter.accountId === accountId ? filter.userId : '';
  const teamView = assignedTo === WORKLIST_MY_TEAM && team.canLead;
  const teamFailed = teamView && team.failed;
  // null while the profile loads: not the same as a guest's empty list.
  const mode = accountRole === null ? null : worklistMode(accountRole);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const now = Date.now();
    void loadWorklistInputs(createClient(), fetch, now, {
      cases: !salesRestricted,
    }).then((read) => {
      if (!live) return;
      setLoaded((prev) => ({
        accountId,
        load: mergeWorklistLoad(
          prev?.accountId === accountId ? prev.load : null,
          read
        ),
        now,
        attempt,
      }));
    });
    return () => {
      live = false;
    };
  }, [accountId, salesRestricted, attempt]);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const read = () => {
      const now = Date.now();
      void loadWaitingChats(createClient()).then((rows) => {
        if (!live) return;
        setWaiting((prev) => {
          const keep = prev && prev.accountId === accountId ? prev : null;
          return rows
            ? {
                accountId,
                rows,
                now,
                failed: false,
                attempt: waitingAttempt,
              }
            : // A blip keeps the last good rows on screen.
              {
                accountId,
                rows: keep?.rows ?? null,
                now: keep?.now ?? now,
                failed: true,
                attempt: waitingAttempt,
              };
        });
      });
    };
    read();
    // Hidden tabs do not poll; coming back reads once (as /live does).
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, WAITING_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [accountId, waitingAttempt]);

  const waitingRows = useMemo(
    () =>
      waiting === null ||
      waiting.rows === null ||
      waiting.accountId !== accountId ||
      !user ||
      mode === null ||
      (teamView && team.ids === null)
        ? null
        : filterWaitingChats(waiting.rows, {
            mode,
            userId: user.id,
            ...(teamView
              ? { team: team.ids }
              : assignedTo && assignedTo !== WORKLIST_MY_TEAM
                ? { assignedTo }
                : {}),
          }),
    [waiting, accountId, user, mode, assignedTo, teamView, team.ids]
  );

  const items = useMemo(
    () =>
      loaded === null ||
      loaded.accountId !== accountId ||
      !user ||
      // "My team" waits for the roster rather than flash everyone's.
      (teamView && team.ids === null)
        ? null
        : rankWorklist(loaded.load.inputs, loaded.now, {
            userId: user.id,
            role: accountRole,
            ...(teamView
              ? { team: team.ids }
              : assignedTo && assignedTo !== WORKLIST_MY_TEAM
                ? { assignedTo }
                : {}),
          }),
    [loaded, accountId, user, accountRole, assignedTo, teamView, team.ids]
  );

  const options = useMemo(
    () =>
      members.map((m) => ({
        userId: m.user_id,
        name: m.full_name || m.email,
      })),
    [members]
  );

  const waitingFailed =
    waiting !== null && waiting.accountId === accountId && waiting.failed;

  return (
    <>
      {mode !== 'none' && (
        <div className="mx-auto mb-4 w-full max-w-6xl">
          <WaitingCustomers
            rows={waitingRows}
            nameOf={nameOf}
            failed={teamFailed || waitingFailed}
            onRetry={teamFailed ? team.retry : retryWaiting}
            retrying={
              !teamFailed && waitingFailed && waiting.attempt !== waitingAttempt
            }
            now={waiting?.now ?? 0}
            capped={
              waiting?.rows && waiting.rows.length >= WAITING_CHATS_LIMIT
                ? WAITING_CHATS_LIMIT
                : null
            }
          />
        </div>
      )}
      <DeskWorklistCard />
      {teamFailed && (
        <ErrorState
          message={tWaiting('teamFailed')}
          onRetry={team.retry}
          className="mx-auto mb-4 w-full max-w-6xl"
        />
      )}
      <WorklistView
        // Not loading: the error above says why there is nothing.
        items={teamFailed ? [] : items}
        load={
          teamFailed || loaded?.accountId !== accountId ? null : loaded.load
        }
        onRetry={retry}
        retrying={loaded !== null && loaded.attempt !== attempt}
        mode={mode}
        nameOf={nameOf}
        assignedTo={assignedTo}
        onAssignedTo={(userId) => setFilter({ accountId, userId })}
        members={options}
        teamOption={team.canLead}
        noTeam={teamView && team.ids !== null && team.ids.length <= 1}
        now={loaded?.now ?? 0}
        // Never "Nothing needs action" while customers wait above it.
        emptyLabel={
          teamFailed
            ? tWaiting('teamFailed')
            : waitingRows && waitingRows.length > 0
              ? tWaiting('emptyOthers')
              : undefined
        }
      />
    </>
  );
}
