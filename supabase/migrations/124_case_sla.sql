-- ============================================================
-- 124_case_sla.sql — case SLA timers, bank contact log and case
-- timeline on 122's cases. Port of module 018c (018c_sla.sql).
--
--  * SLA timers. Three per case: customer_reply (waiting for the
--    customer), bank_response (waiting for the bank), document_chase
--    (chasing documents). case_sla_config is config per (account,
--    bank, stage, timer): amount + unit (minutes | days), due_soon_pct
--    (default 20) or due_soon_minutes (wins when set; capped at the
--    duration). Written only by the account's owner or admin
--    (case_sla_config_upsert / _delete), for a bank the account has
--    (BANK_UNKNOWN) and a stage in that bank's list, the default list
--    when it has none (STAGE_NOT_CONFIGURED). A case with no bank has
--    no SLA.
--  * Deadlines are snapshotted on the timer when it starts
--    (due_soon_at, due_at); a later config change applies from the next
--    start / reset. States: on_track (now < due_soon_at), due_soon
--    (due_soon_at <= now < due_at), overdue (now >= due_at).
--    case_sla_timers holds one row per (case, timer). Every change is a
--    case_sla_state_log row: start / reset -> on_track, stop ->
--    'stopped' (an end marker, not a state), case_sla_evaluate ->
--    due_soon / overdue. cases.sla_state is the worst state of the
--    case's running timers (overdue > due_soon > on_track), NULL when
--    none runs.
--  * Events (case_sla_apply_event, internal; the clock is injected):
--      stage_change      a timer configured for (bank, current stage)
--                        restarts, every other running timer stops.
--      customer_message  customer_reply stops.
--      bank_response     bank_response stops.
--      document_received document_chase restarts when configured for
--                        the stage, else stops.
--    stage_change fires in SQL from an AFTER INSERT trigger on 122's
--    case_stage_history, so every move (case_set_stage, the v1 API's
--    case_apply_submission_status, and case_open's initial stage)
--    resets the timers atomically with the move. document_received
--    fires from a trigger on 123's case_documents when a status becomes
--    'received'. customer_message and bank_response are explicit:
--    case_sla_event (a person who may act on the case) or
--    case_sla_event_system (the inbound pipeline; actor NULL, role
--    'system'). case_sla_timer(start | stop | reset) is the per-timer
--    form (start / reset need a config row: SLA_NOT_CONFIGURED).
--    case_sla_evaluate(now, case) is the SLA job (actor NULL, role
--    'system'): it logs only a change, so a re-run at the same clock
--    logs nothing. The cron lists the cases with work at its clock
--    (case_sla_due_cases, no lock) and evaluates each in its own
--    transaction, so no case write waits behind a sweep of every case.
--  * Bank contact log. case_bank_contacts: who at the bank, when, what
--    was said, the next action and its date. Append-only and INTERNAL
--    (never sent to the customer). Contact name capped at 200, summary
--    and next action at 4000; a blank (whitespace-only) name or summary
--    is refused (CONTACT_INCOMPLETE), a blank next action is stored as
--    NULL.
--  * Timeline. case_timeline(actor, case) merges stage history, tasks,
--    task status changes after the initial open, notes (first 200
--    chars), documents (key + status; the file is an id only), SLA log
--    rows and bank contacts in time order; ties keep log order. Read
--    gate: case_can_read (NOT_ALLOWED, an unknown case included).
--  * Access is the case's: writes need case_rule_can_write of the live
--    case_role (NOT_ALLOWED); reads through RLS follow
--    case_rls_can_read in the caller's active workspace; config to the
--    members of the active workspace.
--  * Writes: no role writes any of these tables, the service role
--    neither; every write is a SECURITY DEFINER case_* function
--    (search_path ''). The state log and bank contacts refuse UPDATE /
--    DELETE / TRUNCATE by trigger (owner included); timers refuse
--    TRUNCATE. Actor columns hold auth user ids with no FK; NULL with
--    role 'system' is the SLA job / inbound pipeline, NULL with 'api'
--    the v1 API.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '124 must be applied by a superuser or BYPASSRLS role (the case_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.case_sla_config (
  account_id       uuid    NOT NULL REFERENCES public.accounts(id),
  bank_code        text    NOT NULL,
  stage            text    NOT NULL,
  timer            text    NOT NULL,
  amount           integer NOT NULL,
  unit             text    NOT NULL,
  due_soon_pct     integer NOT NULL DEFAULT 20,
  due_soon_minutes integer NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_sla_config_pkey PRIMARY KEY (account_id, bank_code, stage, timer),
  CONSTRAINT case_sla_config_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT case_sla_config_stage_check CHECK (stage !~ '^[[:space:]]*$' AND char_length(stage) <= 100),
  CONSTRAINT case_sla_config_timer_check CHECK (timer IN ('customer_reply', 'bank_response', 'document_chase')),
  CONSTRAINT case_sla_config_amount_check CHECK (amount > 0),
  CONSTRAINT case_sla_config_unit_check CHECK (unit IN ('minutes', 'days')),
  CONSTRAINT case_sla_config_pct_check CHECK (due_soon_pct BETWEEN 1 AND 99),
  CONSTRAINT case_sla_config_minutes_check CHECK (due_soon_minutes IS NULL OR due_soon_minutes > 0)
);

COMMENT ON TABLE public.case_sla_config IS
  'SLA durations per (account, bank, stage, timer). Written only through case_sla_config_upsert / _delete (owner/admin). Migration 124.';

CREATE TABLE IF NOT EXISTS public.case_sla_timers (
  case_id     uuid NOT NULL,
  account_id  uuid NOT NULL,
  timer       text NOT NULL,
  stage       text NOT NULL,
  started_at  timestamptz NOT NULL,
  due_soon_at timestamptz NOT NULL,
  due_at      timestamptz NOT NULL,
  stopped_at  timestamptz NULL,
  state       text NULL,
  CONSTRAINT case_sla_timers_pkey PRIMARY KEY (case_id, timer),
  CONSTRAINT case_sla_timers_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_sla_timers_timer_check CHECK (timer IN ('customer_reply', 'bank_response', 'document_chase')),
  CONSTRAINT case_sla_timers_state_check CHECK (state IS NULL OR state IN ('on_track', 'due_soon', 'overdue')),
  CONSTRAINT case_sla_timers_order CHECK (started_at <= due_soon_at AND due_soon_at <= due_at),
  CONSTRAINT case_sla_timers_running CHECK ((stopped_at IS NULL) = (state IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS case_sla_timers_running_idx ON public.case_sla_timers (case_id) WHERE stopped_at IS NULL;

CREATE TABLE IF NOT EXISTS public.case_sla_state_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  timer      text NOT NULL,
  from_state text NULL,
  to_state   text NOT NULL,
  actor_id   uuid NULL,   -- auth user id; NULL = the SLA job / inbound pipeline ('system') or the v1 API ('api')
  actor_role text NOT NULL,
  changed_at timestamptz NOT NULL,
  CONSTRAINT case_sla_state_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_sla_state_log_to_check CHECK (to_state IN ('on_track', 'due_soon', 'overdue', 'stopped'))
);
CREATE INDEX IF NOT EXISTS case_sla_state_log_case_idx ON public.case_sla_state_log (case_id, id);

CREATE TABLE IF NOT EXISTS public.case_bank_contacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid NOT NULL,
  account_id     uuid NOT NULL,
  contact_name   text NOT NULL,
  contacted_at   timestamptz NOT NULL,
  summary        text NOT NULL,
  next_action    text NULL,
  next_action_at timestamptz NULL,
  author_id      uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_bank_contacts_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  -- [[:space:]], not btrim(): btrim strips spaces only.
  CONSTRAINT case_bank_contacts_name_check
    CHECK (contact_name !~ '^[[:space:]]*$' AND char_length(contact_name) <= 200),
  CONSTRAINT case_bank_contacts_summary_check
    CHECK (summary !~ '^[[:space:]]*$' AND char_length(summary) <= 4000),
  CONSTRAINT case_bank_contacts_next_action_check
    CHECK (next_action IS NULL OR (next_action !~ '^[[:space:]]*$' AND char_length(next_action) <= 4000))
);
CREATE INDEX IF NOT EXISTS case_bank_contacts_case_idx ON public.case_bank_contacts (case_id, contacted_at);

COMMENT ON TABLE public.case_bank_contacts IS
  'Bank contact log of a case. Internal: never sent to the customer. Append-only; written only through case_bank_contact_add. Migration 124.';

-- ---------- 2. Integrity (every writer; case_append_only is 122's) ----------

DROP TRIGGER IF EXISTS case_sla_state_log_append_only ON public.case_sla_state_log;
CREATE TRIGGER case_sla_state_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_sla_state_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_sla_state_log_no_truncate ON public.case_sla_state_log;
CREATE TRIGGER case_sla_state_log_no_truncate
  BEFORE TRUNCATE ON public.case_sla_state_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_bank_contacts_append_only ON public.case_bank_contacts;
CREATE TRIGGER case_bank_contacts_append_only
  BEFORE UPDATE OR DELETE ON public.case_bank_contacts
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_bank_contacts_no_truncate ON public.case_bank_contacts;
CREATE TRIGGER case_bank_contacts_no_truncate
  BEFORE TRUNCATE ON public.case_bank_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_sla_timers_no_truncate ON public.case_sla_timers;
CREATE TRIGGER case_sla_timers_no_truncate
  BEFORE TRUNCATE ON public.case_sla_timers
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 3. SLA helpers (internal: no API role executes them) ----------

-- The state of a running timer at p_now.
CREATE OR REPLACE FUNCTION public.case_sla_state_at(p_due_soon_at timestamptz, p_due_at timestamptz, p_now timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_now >= p_due_at THEN 'overdue' WHEN p_now >= p_due_soon_at THEN 'due_soon' ELSE 'on_track' END
$$;

-- cases.sla_state := the worst state of the case's running timers
-- (NULL when none runs); written only when it changes.
CREATE OR REPLACE FUNCTION public.case_sla_refresh_case(p_case uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT CASE max(CASE t.state WHEN 'overdue' THEN 3 WHEN 'due_soon' THEN 2 WHEN 'on_track' THEN 1 END)
           WHEN 3 THEN 'overdue' WHEN 2 THEN 'due_soon' WHEN 1 THEN 'on_track' END
    INTO v_state
    FROM public.case_sla_timers t WHERE t.case_id = p_case AND t.stopped_at IS NULL;
  UPDATE public.cases x SET sla_state = v_state WHERE x.id = p_case AND x.sla_state IS DISTINCT FROM v_state;
  RETURN v_state;
END;
$$;

-- Starts (or restarts) p_timer of a case at p_now from the config of the
-- case's account, bank and current stage, snapshotting the deadlines.
-- False when no config row exists (nothing changes). Logs -> on_track.
-- No permission check: callers have locked the case.
CREATE OR REPLACE FUNCTION public.case_sla_start_one(p_case uuid, p_timer text, p_now timestamptz,
  p_actor uuid, p_actor_role text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  k      public.case_sla_config%ROWTYPE;
  t      public.case_sla_timers%ROWTYPE;
  v_len  interval;
  v_soon interval;
  v_due  timestamptz;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  SELECT * INTO k FROM public.case_sla_config x
   WHERE x.account_id = c.account_id AND x.bank_code = c.bank_code AND x.stage = c.stage AND x.timer = p_timer;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_len := CASE k.unit WHEN 'days' THEN make_interval(days => k.amount) ELSE make_interval(mins => k.amount) END;
  v_soon := coalesce(make_interval(mins => k.due_soon_minutes),
                     (extract(epoch FROM v_len) * k.due_soon_pct / 100.0) * interval '1 second');
  IF v_soon > v_len THEN
    v_soon := v_len;
  END IF;
  v_due := p_now + v_len;
  SELECT * INTO t FROM public.case_sla_timers x WHERE x.case_id = p_case AND x.timer = p_timer FOR UPDATE;
  INSERT INTO public.case_sla_timers AS s (case_id, account_id, timer, stage, started_at, due_soon_at, due_at,
                                           stopped_at, state)
  VALUES (p_case, c.account_id, p_timer, c.stage, p_now, v_due - v_soon, v_due, NULL, 'on_track')
  ON CONFLICT ON CONSTRAINT case_sla_timers_pkey DO UPDATE
    SET stage = EXCLUDED.stage, started_at = EXCLUDED.started_at, due_soon_at = EXCLUDED.due_soon_at,
        due_at = EXCLUDED.due_at, stopped_at = NULL, state = 'on_track';
  INSERT INTO public.case_sla_state_log (case_id, account_id, timer, from_state, to_state, actor_id, actor_role, changed_at)
  VALUES (p_case, c.account_id, p_timer,
          CASE WHEN t.case_id IS NULL THEN NULL WHEN t.stopped_at IS NULL THEN t.state ELSE 'stopped' END,
          'on_track', p_actor, p_actor_role, p_now);
  RETURN true;
END;
$$;

-- Stops p_timer if it runs; logs -> 'stopped'. Whether it was running.
CREATE OR REPLACE FUNCTION public.case_sla_stop_one(p_case uuid, p_timer text, p_now timestamptz,
  p_actor uuid, p_actor_role text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.case_sla_timers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.case_sla_timers x
   WHERE x.case_id = p_case AND x.timer = p_timer AND x.stopped_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.case_sla_timers x SET stopped_at = p_now, state = NULL WHERE x.case_id = p_case AND x.timer = p_timer;
  INSERT INTO public.case_sla_state_log (case_id, account_id, timer, from_state, to_state, actor_id, actor_role, changed_at)
  VALUES (p_case, t.account_id, p_timer, t.state, 'stopped', p_actor, p_actor_role, p_now);
  RETURN true;
END;
$$;

-- An SLA event (see the header). No permission check: the public
-- wrappers and the triggers below are its only callers. Locks the case
-- (FOR NO KEY UPDATE: cases.sla_state is not a key) before any timer, as
-- every SLA writer does. Returns the case's new sla_state.
CREATE OR REPLACE FUNCTION public.case_sla_apply_event(p_case uuid, p_event text, p_now timestamptz,
  p_actor uuid, p_actor_role text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_timer text;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('stage_change', 'customer_message', 'bank_response', 'document_received') THEN
    RAISE EXCEPTION 'SLA event % is not stage_change, customer_message, bank_response or document_received', p_event
      USING ERRCODE = 'check_violation', HINT = 'EVENT_INVALID';
  END IF;
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF p_event = 'stage_change' THEN
    FOREACH v_timer IN ARRAY ARRAY['customer_reply', 'bank_response', 'document_chase'] LOOP
      IF NOT public.case_sla_start_one(p_case, v_timer, p_now, p_actor, p_actor_role) THEN
        PERFORM public.case_sla_stop_one(p_case, v_timer, p_now, p_actor, p_actor_role);
      END IF;
    END LOOP;
  ELSIF p_event = 'customer_message' THEN
    PERFORM public.case_sla_stop_one(p_case, 'customer_reply', p_now, p_actor, p_actor_role);
  ELSIF p_event = 'bank_response' THEN
    PERFORM public.case_sla_stop_one(p_case, 'bank_response', p_now, p_actor, p_actor_role);
  ELSE  -- document_received
    IF NOT public.case_sla_start_one(p_case, 'document_chase', p_now, p_actor, p_actor_role) THEN
      PERFORM public.case_sla_stop_one(p_case, 'document_chase', p_now, p_actor, p_actor_role);
    END IF;
  END IF;
  RETURN public.case_sla_refresh_case(p_case);
END;
$$;

-- Refuses a missing or infinite clock (NOW_REQUIRED).
CREATE OR REPLACE FUNCTION public.case_sla_require_now(p_now timestamptz, p_what text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION '% needs a finite clock', p_what USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
END;
$$;

-- ---------- 4. Automatic events (triggers) ----------

-- Every stage move — the initial stage of case_open included — resets
-- the timers for the new stage in the same transaction. Never raises
-- for a case with no SLA config (the timers just stop).
CREATE OR REPLACE FUNCTION public.case_sla_on_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.case_sla_apply_event(NEW.case_id, 'stage_change', NEW.changed_at, NEW.actor_id, NEW.actor_role);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_stage_history_sla ON public.case_stage_history;
CREATE TRIGGER case_stage_history_sla
  AFTER INSERT ON public.case_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.case_sla_on_stage_history();

-- A document whose status becomes 'received' (and was not) restarts
-- document_chase when configured for the stage, else stops it.
CREATE OR REPLACE FUNCTION public.case_sla_on_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'received' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'received') THEN
    PERFORM public.case_sla_apply_event(NEW.case_id, 'document_received', NEW.updated_at, NEW.updated_by,
      coalesce(public.case_role(NEW.case_id, NEW.updated_by), 'none'));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_documents_sla ON public.case_documents;
CREATE TRIGGER case_documents_sla
  AFTER INSERT OR UPDATE OF status ON public.case_documents
  FOR EACH ROW EXECUTE FUNCTION public.case_sla_on_document();

-- ---------- 5. SLA API ----------

-- Explicit per-timer control by a person who may act on the case:
-- start | reset (restart at p_now; needs a config row, else
-- SLA_NOT_CONFIGURED) | stop. Returns the case's new sla_state.
CREATE OR REPLACE FUNCTION public.case_sla_timer(p_case uuid, p_actor uuid, p_timer text, p_action text,
  p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM public.case_sla_require_now(p_now, 'case_sla_timer');
  -- The write lock first, then the role check (which takes FOR SHARE on
  -- the row it already holds): two concurrent SLA writers queue, never
  -- deadlock on an upgrade.
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  v_role := public.case_tools_lock_for_write(p_case, p_actor);
  IF p_timer IS NULL OR p_timer NOT IN ('customer_reply', 'bank_response', 'document_chase') THEN
    RAISE EXCEPTION 'timer % is not customer_reply, bank_response or document_chase', p_timer
      USING ERRCODE = 'check_violation', HINT = 'TIMER_INVALID';
  END IF;
  IF p_action IN ('start', 'reset') THEN
    IF NOT public.case_sla_start_one(p_case, p_timer, p_now, p_actor, v_role) THEN
      RAISE EXCEPTION 'no SLA configured for timer % at this case''s bank and stage', p_timer
        USING ERRCODE = 'no_data_found', HINT = 'SLA_NOT_CONFIGURED';
    END IF;
  ELSIF p_action = 'stop' THEN
    PERFORM public.case_sla_stop_one(p_case, p_timer, p_now, p_actor, v_role);
  ELSE
    RAISE EXCEPTION 'timer action % is not start, stop or reset', p_action
      USING ERRCODE = 'check_violation', HINT = 'ACTION_INVALID';
  END IF;
  RETURN public.case_sla_refresh_case(p_case);
END;
$$;

-- An SLA event reported by a person who may act on the case:
-- customer_message or bank_response only (EVENT_INVALID otherwise;
-- stage_change and document_received fire from 124's triggers). Returns the case's new sla_state.
CREATE OR REPLACE FUNCTION public.case_sla_event(p_case uuid, p_actor uuid, p_event text, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM public.case_sla_require_now(p_now, 'case_sla_event');
  IF p_event IS NULL OR p_event NOT IN ('customer_message', 'bank_response') THEN
    RAISE EXCEPTION 'SLA event % is not customer_message or bank_response (stage_change and document_received fire from triggers)', p_event
      USING ERRCODE = 'check_violation', HINT = 'EVENT_INVALID';
  END IF;
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  v_role := public.case_tools_lock_for_write(p_case, p_actor);
  RETURN public.case_sla_apply_event(p_case, p_event, p_now, p_actor, v_role);
END;
$$;

-- An SLA event from the system (the inbound pipeline's
-- customer_message): actor NULL, role 'system'. Explicit events only,
-- as case_sla_event.
CREATE OR REPLACE FUNCTION public.case_sla_event_system(p_case uuid, p_event text, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.case_sla_require_now(p_now, 'case_sla_event_system');
  IF p_event IS NULL OR p_event NOT IN ('customer_message', 'bank_response') THEN
    RAISE EXCEPTION 'SLA event % is not customer_message or bank_response (stage_change and document_received fire from triggers)', p_event
      USING ERRCODE = 'check_violation', HINT = 'EVENT_INVALID';
  END IF;
  RETURN public.case_sla_apply_event(p_case, p_event, p_now, NULL, 'system');
END;
$$;

-- The SLA job: evaluates the running timers (of one case, or of every
-- case when p_case is NULL) at the injected clock and records each state
-- CHANGE once (actor NULL, role 'system'). Locks each case before its
-- timers, as the events do. Returns the changes.
CREATE OR REPLACE FUNCTION public.case_sla_evaluate(p_now timestamptz, p_case uuid DEFAULT NULL)
RETURNS TABLE (case_id uuid, timer text, from_state text, to_state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_case  uuid;
  t       public.case_sla_timers%ROWTYPE;
  v_state text;
  v_moved boolean;
BEGIN
  PERFORM public.case_sla_require_now(p_now, 'case_sla_evaluate');
  FOR v_case IN
    SELECT DISTINCT x.case_id FROM public.case_sla_timers x
     WHERE x.stopped_at IS NULL AND (p_case IS NULL OR x.case_id = p_case)
     ORDER BY 1
  LOOP
    PERFORM 1 FROM public.cases c WHERE c.id = v_case FOR NO KEY UPDATE;
    v_moved := false;
    FOR t IN
      SELECT * FROM public.case_sla_timers x
       WHERE x.case_id = v_case AND x.stopped_at IS NULL
       ORDER BY x.timer
         FOR UPDATE
    LOOP
      v_state := public.case_sla_state_at(t.due_soon_at, t.due_at, p_now);
      IF v_state IS DISTINCT FROM t.state THEN
        UPDATE public.case_sla_timers x SET state = v_state WHERE x.case_id = t.case_id AND x.timer = t.timer;
        INSERT INTO public.case_sla_state_log (case_id, account_id, timer, from_state, to_state, actor_id, actor_role,
                                               changed_at)
        VALUES (t.case_id, t.account_id, t.timer, t.state, v_state, NULL, 'system', p_now);
        v_moved := true;
        case_id := t.case_id; timer := t.timer; from_state := t.state; to_state := v_state;
        RETURN NEXT;
      END IF;
    END LOOP;
    IF v_moved THEN
      PERFORM public.case_sla_refresh_case(v_case);
    END IF;
  END LOOP;
END;
$$;

-- The cases the SLA job has work on at p_now: those with a running
-- timer whose state at p_now differs from the stored one, ordered by
-- id, at most p_limit (clamped to 1 .. 5000). It takes no lock: the
-- cron calls case_sla_evaluate(p_now, case) once per returned case, each
-- its own transaction, because case_sla_evaluate(p_now, NULL) holds
-- every running case's lock until the whole sweep commits.
CREATE OR REPLACE FUNCTION public.case_sla_due_cases(p_now timestamptz, p_limit int DEFAULT 500)
RETURNS TABLE (case_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.case_sla_require_now(p_now, 'case_sla_due_cases');
  RETURN QUERY
    SELECT DISTINCT x.case_id FROM public.case_sla_timers x
     WHERE x.stopped_at IS NULL
       AND public.case_sla_state_at(x.due_soon_at, x.due_at, p_now) IS DISTINCT FROM x.state
     ORDER BY 1
     LIMIT greatest(1, least(coalesce(p_limit, 500), 5000));
END;
$$;

-- ---------- 6. Bank contact log ----------

-- Records a bank contact for a person who may act on the case. Returns
-- its id.
CREATE OR REPLACE FUNCTION public.case_bank_contact_add(p_case uuid, p_actor uuid, p_contact_name text,
  p_contacted_at timestamptz, p_summary text, p_next_action text DEFAULT NULL,
  p_next_action_at timestamptz DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_id      uuid;
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  IF p_contact_name IS NULL OR p_contact_name ~ '^[[:space:]]*$' OR p_summary IS NULL OR p_summary ~ '^[[:space:]]*$'
     OR p_contacted_at IS NULL THEN
    RAISE EXCEPTION 'a bank contact needs who, when and what was said'
      USING ERRCODE = 'check_violation', HINT = 'CONTACT_INCOMPLETE';
  END IF;
  IF char_length(p_contact_name) > 200 OR char_length(p_summary) > 4000
     OR char_length(coalesce(p_next_action, '')) > 4000 THEN
    RAISE EXCEPTION 'bank contact text is over its cap (name 200, summary / next action 4000)'
      USING ERRCODE = 'check_violation', HINT = 'TEXT_TOO_LONG';
  END IF;
  SELECT x.account_id INTO v_account FROM public.cases x WHERE x.id = p_case;
  INSERT INTO public.case_bank_contacts (case_id, account_id, contact_name, contacted_at, summary, next_action,
                                         next_action_at, author_id, created_at)
  VALUES (p_case, v_account, p_contact_name, p_contacted_at, p_summary,
          CASE WHEN p_next_action ~ '^[[:space:]]*$' THEN NULL ELSE p_next_action END, p_next_action_at,
          p_actor, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 7. Timeline ----------

-- Every in-database source of a case, merged and time-ordered, for a
-- person who may read it (NOT_ALLOWED otherwise, an unknown case included). Ties at the
-- same instant are ordered by kind, then log order (stage, task_status
-- and sla carry their log id), then ref_id.
CREATE OR REPLACE FUNCTION public.case_timeline(p_actor uuid, p_case uuid)
RETURNS TABLE (at timestamptz, kind text, ref_id text, actor uuid, summary text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- An unknown case answers as another account's (no existence oracle).
  IF NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case %: % may not read it', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
    SELECT e.at, e.kind, e.ref_id, e.actor, e.summary FROM (
      SELECT h.changed_at AS at, 'stage'::text AS kind, h.id::text AS ref_id, h.actor_id AS actor,
             coalesce(h.from_stage || ' -> ', '') || h.to_stage || coalesce(' (' || h.outcome || ')', '') AS summary,
             h.id AS sk
        FROM public.case_stage_history h WHERE h.case_id = p_case
      UNION ALL
      SELECT t.created_at, 'task', t.id::text, t.created_by, t.title, 0::bigint
        FROM public.case_tasks t WHERE t.case_id = p_case
      UNION ALL
      SELECT l.changed_at, 'task_status', l.task_id::text, l.actor_id,
             t.title || ': ' || l.from_status || ' -> ' || l.to_status, l.id
        FROM public.case_task_status_log l JOIN public.case_tasks t ON t.id = l.task_id
       WHERE l.case_id = p_case AND l.from_status IS NOT NULL
      UNION ALL
      SELECT n.created_at, 'note', n.id::text, n.author_id, left(n.body, 200), 0::bigint
        FROM public.case_notes n WHERE n.case_id = p_case
      UNION ALL
      SELECT d.updated_at, 'document', d.doc_key, d.updated_by,
             d.doc_key || ': ' || d.status || coalesce(' [file ' || d.file_ref || ']', ''), 0::bigint
        FROM public.case_documents d WHERE d.case_id = p_case
      UNION ALL
      SELECT s.changed_at, 'sla', s.timer, s.actor_id,
             s.timer || ': ' || coalesce(s.from_state, 'none') || ' -> ' || s.to_state, s.id
        FROM public.case_sla_state_log s WHERE s.case_id = p_case
      UNION ALL
      SELECT b.contacted_at, 'bank_contact', b.id::text, b.author_id,
             b.contact_name || ': ' || left(b.summary, 200), 0::bigint
        FROM public.case_bank_contacts b WHERE b.case_id = p_case
    ) e
    ORDER BY e.at, e.kind, e.sk, e.ref_id;
END;
$$;

-- ---------- 8. Configuration (owner/admin of the account) ----------

-- Adds or updates the SLA of a timer at a bank's stage. The stage must
-- be in the bank's list (the default list when it has none). Returns
-- the stored row. Running timers keep their snapshotted deadlines.
CREATE OR REPLACE FUNCTION public.case_sla_config_upsert(p_actor uuid, p_account uuid, p_bank_code text,
  p_stage text, p_timer text, p_amount int, p_unit text, p_due_soon_pct int DEFAULT 20,
  p_due_soon_minutes int DEFAULT NULL)
RETURNS public.case_sla_config
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.case_sla_config%ROWTYPE;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure SLAs of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  IF p_stage IS NULL OR NOT (p_stage = ANY (public.case_stages_for_bank(p_account, p_bank_code))) THEN
    RAISE EXCEPTION 'stage % is not configured for bank %', p_stage, p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_CONFIGURED';
  END IF;
  INSERT INTO public.case_sla_config AS k (account_id, bank_code, stage, timer, amount, unit, due_soon_pct,
                                           due_soon_minutes)
  VALUES (p_account, p_bank_code, p_stage, p_timer, p_amount, p_unit, coalesce(p_due_soon_pct, 20), p_due_soon_minutes)
  ON CONFLICT ON CONSTRAINT case_sla_config_pkey
  DO UPDATE SET amount = EXCLUDED.amount, unit = EXCLUDED.unit, due_soon_pct = EXCLUDED.due_soon_pct,
                due_soon_minutes = EXCLUDED.due_soon_minutes, updated_at = now()
  RETURNING k.* INTO v_row;
  RETURN v_row;
END;
$$;

-- Deletes the SLA of a timer at a bank's stage; running timers keep
-- their deadlines. Returns whether a row was deleted.
CREATE OR REPLACE FUNCTION public.case_sla_config_delete(p_actor uuid, p_account uuid, p_bank_code text,
  p_stage text, p_timer text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure SLAs of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  DELETE FROM public.case_sla_config k
   WHERE k.account_id = p_account AND k.bank_code = p_bank_code AND k.stage = p_stage AND k.timer = p_timer;
  RETURN FOUND;
END;
$$;

-- ---------- 9. Row level security ----------

ALTER TABLE public.case_sla_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_sla_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_sla_timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_sla_timers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_sla_state_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_sla_state_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_bank_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_bank_contacts FORCE ROW LEVEL SECURITY;

-- SELECT only: config to members of the active workspace, the rest
-- to whoever reads the case.
DROP POLICY IF EXISTS case_sla_config_select ON public.case_sla_config;
CREATE POLICY case_sla_config_select ON public.case_sla_config FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS case_sla_timers_select ON public.case_sla_timers;
CREATE POLICY case_sla_timers_select ON public.case_sla_timers FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_sla_state_log_select ON public.case_sla_state_log;
CREATE POLICY case_sla_state_log_select ON public.case_sla_state_log FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_bank_contacts_select ON public.case_bank_contacts;
CREATE POLICY case_bank_contacts_select ON public.case_bank_contacts FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 10. Privileges ----------

-- Start from nothing, then the minimum: reads to authenticated (under
-- RLS) and the service role, writes to nobody.
REVOKE ALL ON public.case_sla_config, public.case_sla_timers, public.case_sla_state_log, public.case_bank_contacts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_sla_state_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_sla_config, public.case_sla_timers, public.case_sla_state_log, public.case_bank_contacts
  TO authenticated, service_role;

-- Internal: helpers and trigger functions, executed by no API role.
REVOKE ALL ON FUNCTION
  public.case_sla_state_at(timestamptz, timestamptz, timestamptz),
  public.case_sla_refresh_case(uuid),
  public.case_sla_start_one(uuid, text, timestamptz, uuid, text),
  public.case_sla_stop_one(uuid, text, timestamptz, uuid, text),
  public.case_sla_apply_event(uuid, text, timestamptz, uuid, text),
  public.case_sla_require_now(timestamptz, text),
  public.case_sla_on_stage_history(),
  public.case_sla_on_document()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_sla_timer(uuid, uuid, text, text, timestamptz),
  public.case_sla_event(uuid, uuid, text, timestamptz),
  public.case_sla_event_system(uuid, text, timestamptz),
  public.case_sla_evaluate(timestamptz, uuid),
  public.case_sla_due_cases(timestamptz, int),
  public.case_bank_contact_add(uuid, uuid, text, timestamptz, text, text, timestamptz, timestamptz),
  public.case_timeline(uuid, uuid),
  public.case_sla_config_upsert(uuid, uuid, text, text, text, int, text, int, int),
  public.case_sla_config_delete(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_sla_timer(uuid, uuid, text, text, timestamptz),
  public.case_sla_event(uuid, uuid, text, timestamptz),
  public.case_sla_event_system(uuid, text, timestamptz),
  public.case_sla_evaluate(timestamptz, uuid),
  public.case_sla_due_cases(timestamptz, int),
  public.case_bank_contact_add(uuid, uuid, text, timestamptz, text, text, timestamptz, timestamptz),
  public.case_timeline(uuid, uuid),
  public.case_sla_config_upsert(uuid, uuid, text, text, text, int, text, int, int),
  public.case_sla_config_delete(uuid, uuid, text, text, text)
  TO service_role;

RESET lock_timeout;
