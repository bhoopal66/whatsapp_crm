-- ============================================================
-- 186_case_macros.sql — case macros: a saved list of case actions a
-- person applies to one case in one click. Port of module 020c part 2
-- (020c_macros.sql). As in 185: the package's IT role does not exist
-- here, its workspace is the account, its users are profiles, its
-- super_admin is the owner.
--
-- Nothing changes until someone acts: no macro exists until a person
-- saves one, and applying one only ever calls the NORMAL case functions
-- as that person, so a macro never widens what its user may do.
--
--  * case_macros, one row per macro: name 1..60 characters, not blank;
--    actions a jsonb array of 1..10 action objects; shared flag. The
--    sharing model is 185's saved views exactly, keyed on
--    case_view_account (the actor's ACTIVE live profile, holding a case
--    role there: owner, admin, team leader, agent; viewers and bank
--    guests NOT_ALLOWED):
--      case_macro_list(actor)     own macros + shared macros of the
--                                 workspace; shared first, then name
--      case_macro_get(actor, macro)   one of those; else MACRO_NOT_FOUND
--      case_macro_save(actor, macro, name, actions, shared)
--                                 macro NULL creates; else replaces the
--                                 actor's OWN macro; shared = true needs
--                                 owner/admin (also on an update)
--      case_macro_delete(actor, macro)   the owner, or an owner/admin of
--                                 the workspace for ANY of its macros
--    Another person's private macro and any other workspace's macro are
--    MACRO_NOT_FOUND, never NOT_ALLOWED (no existence oracle).
--
--  * Actions, a closed list checked by case_macro_validate_actions (an
--    unknown kind, an unknown key, a wrong type or an out-of-range value
--    is ACTION_INVALID). Every key is camelCase, as the server sends it:
--      add_task          {kind, templateKey, dueHours?, ownerRole}
--                        templateKey is required and has 123's key shape
--                        (^[a-z0-9_]{1,64}$): a title-only task could
--                        never run. dueHours an integer 1..8760.
--                        ownerRole 'agent' | 'coordinator' | 'me'.
--      add_note          {kind, body}  body 1..4000 characters, not
--                        blank; may hold {{customer}} (the case's contact
--                        name) and {{bank}} (case_banks.name), expanded
--                        by the server before case_note_add.
--      set_stage         {kind, stage, outcome?}  stage 1..60 characters;
--                        outcome 'Approved' | 'Declined' | 'Withdrawn'.
--      request_documents {kind}  a PREVIEW only: the server reads the
--                        missing-documents list and sends nothing.
--
--  * APPLYING is the server's job, action by action, through the normal
--    functions as the actor (case_task_create, case_note_add,
--    case_set_stage, case_doc_request_begin), so every role, stage and
--    Compass (MANAGED_EXTERNALLY) rule still applies; there is no
--    transaction across actions and the run stops at the first refusal.
--    This file only stores, validates and records the outcome:
--      case_macro_log_apply(actor, case, macro, applied, now)
--    appends one row to the append-only case_macro_log (applied: a jsonb
--    array of 1..10 {kind, ok, refusal}). The macro must be visible to
--    the actor (MACRO_NOT_FOUND) and the case readable by them in their
--    active workspace (case_can_read, CASE_NOT_FOUND). The log has no FK
--    to the macro: it outlives a deleted macro.
--
-- Refusals (hint): NOT_ALLOWED, ACTION_INVALID, NAME_INVALID,
-- MACRO_NOT_FOUND, CASE_NOT_FOUND.
-- RLS (forced): authenticated reads its own macros and the shared macros
-- of its active account, and the log rows of cases it can read; nobody
-- writes either table directly. Every function is SECURITY DEFINER over
-- RLS-forced tables, so, as 125, 162 and 185, this must be applied by a
-- superuser or BYPASSRLS role. Only service_role executes them.
-- Re-runnable: IF NOT EXISTS guards, CREATE OR REPLACE, DROP IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '186 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.case_macros (
  macro_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id),
  owner_user_id uuid NOT NULL,
  name          text NOT NULL,
  actions       jsonb NOT NULL,
  shared        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- [[:space:]], not btrim(): btrim strips spaces only.
  CONSTRAINT case_macros_name_check CHECK (name !~ '^[[:space:]]*$' AND char_length(name) <= 60),
  CONSTRAINT case_macros_actions_check
    CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 10)
);
CREATE INDEX IF NOT EXISTS case_macros_owner_idx ON public.case_macros (account_id, owner_user_id);
CREATE INDEX IF NOT EXISTS case_macros_shared_idx ON public.case_macros (account_id) WHERE shared;

CREATE TABLE IF NOT EXISTS public.case_macro_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL,
  case_id    uuid NOT NULL,
  macro_id   uuid NOT NULL,  -- no FK: the log outlives a deleted macro
  actor_id   uuid NOT NULL,
  actor_role text NOT NULL,
  applied    jsonb NOT NULL,
  at         timestamptz NOT NULL,
  CONSTRAINT case_macro_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_macro_log_role_check
    CHECK (actor_role IN ('super_admin', 'admin', 'team_lead', 'coordinator', 'agent')),
  CONSTRAINT case_macro_log_applied_check CHECK (jsonb_typeof(applied) = 'array')
);
CREATE INDEX IF NOT EXISTS case_macro_log_case_idx ON public.case_macro_log (case_id, at);

-- ---------- 2. Integrity (every writer; case_append_only is 122's) ----------

DROP TRIGGER IF EXISTS case_macro_log_append_only ON public.case_macro_log;
CREATE TRIGGER case_macro_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_macro_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_macro_log_no_truncate ON public.case_macro_log;
CREATE TRIGGER case_macro_log_no_truncate
  BEFORE TRUNCATE ON public.case_macro_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 3. The action validator ----------

-- Raises ACTION_INVALID naming the action's position (0-based). Internal.
CREATE OR REPLACE FUNCTION public.case_macro_action_refuse(p_index int, p_msg text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'macro action %: %', p_index, p_msg
    USING ERRCODE = 'invalid_parameter_value', HINT = 'ACTION_INVALID';
END;
$$;

-- The one place macro actions are checked (case_macro_save). Internal.
CREATE OR REPLACE FUNCTION public.case_macro_validate_actions(p_actions jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  a         jsonb;
  i         int := 0;
  k         text;
  v_kind    text;
  v_allowed text[];
BEGIN
  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array' THEN
    PERFORM public.case_macro_action_refuse(0, 'actions must be an array');
  END IF;
  IF jsonb_array_length(p_actions) NOT BETWEEN 1 AND 10 THEN
    PERFORM public.case_macro_action_refuse(0, 'a macro has 1..10 actions');
  END IF;
  FOR a IN SELECT x FROM jsonb_array_elements(p_actions) x LOOP
    IF jsonb_typeof(a) <> 'object' OR jsonb_typeof(a -> 'kind') IS DISTINCT FROM 'string' THEN
      PERFORM public.case_macro_action_refuse(i, 'an action is an object with a string kind');
    END IF;
    v_kind := a ->> 'kind';
    v_allowed := CASE v_kind
      WHEN 'add_task'          THEN ARRAY['kind', 'templateKey', 'dueHours', 'ownerRole']
      WHEN 'add_note'          THEN ARRAY['kind', 'body']
      WHEN 'set_stage'         THEN ARRAY['kind', 'stage', 'outcome']
      WHEN 'request_documents' THEN ARRAY['kind']
    END;
    IF v_allowed IS NULL THEN
      PERFORM public.case_macro_action_refuse(i, format('unknown kind %s', left(v_kind, 64)));
    END IF;
    FOR k IN SELECT jsonb_object_keys(a) LOOP
      IF NOT (k = ANY (v_allowed)) THEN
        PERFORM public.case_macro_action_refuse(i, format('unknown key %s for %s', left(k, 64), v_kind));
      END IF;
    END LOOP;

    IF v_kind = 'add_task' THEN
      -- 123's template key shape; a title-only task could never run
      IF jsonb_typeof(a -> 'templateKey') IS DISTINCT FROM 'string'
         OR (a ->> 'templateKey') !~ '^[a-z0-9_]{1,64}$' THEN
        PERFORM public.case_macro_action_refuse(i, 'add_task needs a templateKey (a-z, 0-9, _; 1..64)');
      END IF;
      -- CASE, not OR: OR does not promise to skip the cast on a non-integer
      IF a ? 'dueHours' AND NOT (CASE
           WHEN jsonb_typeof(a -> 'dueHours') = 'number' AND (a ->> 'dueHours') ~ '^[0-9]{1,4}$'
             THEN (a ->> 'dueHours')::int BETWEEN 1 AND 8760
           ELSE false END) THEN
        PERFORM public.case_macro_action_refuse(i, 'dueHours must be an integer 1..8760');
      END IF;
      IF jsonb_typeof(a -> 'ownerRole') IS DISTINCT FROM 'string'
         OR (a ->> 'ownerRole') NOT IN ('agent', 'coordinator', 'me') THEN
        PERFORM public.case_macro_action_refuse(i, 'ownerRole must be agent, coordinator or me');
      END IF;
    ELSIF v_kind = 'add_note' THEN
      IF jsonb_typeof(a -> 'body') IS DISTINCT FROM 'string'
         OR (a ->> 'body') ~ '^[[:space:]]*$' OR char_length(a ->> 'body') > 4000 THEN
        PERFORM public.case_macro_action_refuse(i, 'body must be 1..4000 characters');
      END IF;
    ELSIF v_kind = 'set_stage' THEN
      IF jsonb_typeof(a -> 'stage') IS DISTINCT FROM 'string'
         OR (a ->> 'stage') ~ '^[[:space:]]*$' OR char_length(a ->> 'stage') > 60 THEN
        PERFORM public.case_macro_action_refuse(i, 'stage must be 1..60 characters');
      END IF;
      IF a ? 'outcome' AND (jsonb_typeof(a -> 'outcome') <> 'string'
                            OR (a ->> 'outcome') NOT IN ('Approved', 'Declined', 'Withdrawn')) THEN
        PERFORM public.case_macro_action_refuse(i, 'outcome must be Approved, Declined or Withdrawn');
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
END;
$$;

-- ---------- 4. Macros ----------

CREATE OR REPLACE FUNCTION public.case_macro_list(p_actor uuid)
RETURNS SETOF public.case_macros
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'case_macro_list: no actor' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF a.account_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT x.* FROM public.case_macros x
     WHERE x.account_id = a.account_id AND (x.owner_user_id = p_actor OR x.shared)
     ORDER BY x.shared DESC, x.name, x.macro_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_macro_get(p_actor uuid, p_macro uuid)
RETURNS public.case_macros
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
  m public.case_macros%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_macro_get: % may not use macros', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO m FROM public.case_macros x
   WHERE x.macro_id = p_macro AND x.account_id = a.account_id AND (x.owner_user_id = p_actor OR x.shared);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'macro % not found', p_macro USING ERRCODE = 'no_data_found', HINT = 'MACRO_NOT_FOUND';
  END IF;
  RETURN m;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_macro_save(p_actor uuid, p_macro uuid, p_name text, p_actions jsonb,
  p_shared boolean)
RETURNS public.case_macros
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a        record;
  m        public.case_macros%ROWTYPE;
  v_name   text;
  v_shared boolean := coalesce(p_shared, false);
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_macro_save: % may not save macros', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  v_name := regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF v_name = '' OR char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'macro name must be 1..60 characters' USING ERRCODE = 'invalid_parameter_value', HINT = 'NAME_INVALID';
  END IF;
  PERFORM public.case_macro_validate_actions(p_actions);
  IF v_shared AND a.role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'case_macro_save: only an owner or admin shares a macro'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;

  IF p_macro IS NULL THEN
    INSERT INTO public.case_macros (account_id, owner_user_id, name, actions, shared)
    VALUES (a.account_id, p_actor, v_name, p_actions, v_shared)
    RETURNING * INTO m;
    RETURN m;
  END IF;

  SELECT * INTO m FROM public.case_macros x
   WHERE x.macro_id = p_macro AND x.account_id = a.account_id AND (x.owner_user_id = p_actor OR x.shared)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'macro % not found', p_macro USING ERRCODE = 'no_data_found', HINT = 'MACRO_NOT_FOUND';
  END IF;
  IF m.owner_user_id <> p_actor THEN
    RAISE EXCEPTION 'case_macro_save: only the owner changes a macro'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  UPDATE public.case_macros x
     SET name = v_name, actions = p_actions, shared = v_shared, updated_at = now()
   WHERE x.macro_id = p_macro
  RETURNING * INTO m;
  RETURN m;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_macro_delete(p_actor uuid, p_macro uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a       record;
  m       public.case_macros%ROWTYPE;
  v_admin boolean;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_macro_delete: % may not delete macros', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  v_admin := a.role IN ('super_admin', 'admin');
  SELECT * INTO m FROM public.case_macros x
   WHERE x.macro_id = p_macro AND x.account_id = a.account_id
   FOR UPDATE;
  -- another person's private macro is not found (no existence oracle)
  IF NOT FOUND OR (m.owner_user_id <> p_actor AND NOT m.shared AND NOT v_admin) THEN
    RAISE EXCEPTION 'macro % not found', p_macro USING ERRCODE = 'no_data_found', HINT = 'MACRO_NOT_FOUND';
  END IF;
  IF m.owner_user_id <> p_actor AND NOT v_admin THEN
    RAISE EXCEPTION 'case_macro_delete: only the owner, an owner or an admin'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  DELETE FROM public.case_macros x WHERE x.macro_id = p_macro;
END;
$$;

-- Records one apply. The server has already run each action through
-- its normal function as the actor; this checks visibility again and
-- appends the outcome. applied: 1..10 objects {kind, ok, refusal}.
CREATE OR REPLACE FUNCTION public.case_macro_log_apply(p_actor uuid, p_case uuid, p_macro uuid, p_applied jsonb,
  p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m      public.case_macros%ROWTYPE;
  e      jsonb;
  v_role text;
  v_id   bigint;
BEGIN
  m := public.case_macro_get(p_actor, p_macro);  -- NOT_ALLOWED / MACRO_NOT_FOUND
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case AND c.account_id = m.account_id)
     OR NOT public.case_can_read(p_case, p_actor) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF p_applied IS NULL OR jsonb_typeof(p_applied) <> 'array' OR jsonb_array_length(p_applied) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'applied must be an array of 1..10 results'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'ACTION_INVALID';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_applied) x LOOP
    IF jsonb_typeof(e) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'ok', 'refusal'))
       OR (e ->> 'kind') IS NULL
       OR (e ->> 'kind') NOT IN ('add_task', 'add_note', 'set_stage', 'request_documents')
       OR jsonb_typeof(e -> 'ok') IS DISTINCT FROM 'boolean'
       OR (e ? 'refusal' AND jsonb_typeof(e -> 'refusal') NOT IN ('string', 'null'))
       OR char_length(coalesce(e ->> 'refusal', '')) > 200 THEN
      RAISE EXCEPTION 'applied holds {kind, ok, refusal} objects'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'ACTION_INVALID';
    END IF;
  END LOOP;
  v_role := public.case_role(p_case, p_actor);
  INSERT INTO public.case_macro_log (account_id, case_id, macro_id, actor_id, actor_role, applied, at)
  VALUES (m.account_id, p_case, p_macro, p_actor, v_role, p_applied, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.case_macro_list(uuid) IS
  'The actor''s own case macros and the shared macros of their active workspace (shared first, then name). service_role only. Migration 186.';
COMMENT ON FUNCTION public.case_macro_get(uuid, uuid) IS
  'One case macro the actor may see (own or shared, active workspace); else MACRO_NOT_FOUND. service_role only. Migration 186.';
COMMENT ON FUNCTION public.case_macro_save(uuid, uuid, text, jsonb, boolean) IS
  'Creates (macro id NULL) or replaces the actor''s own case macro; sharing needs owner/admin; actions through case_macro_validate_actions. Another person''s private macro: MACRO_NOT_FOUND. service_role only. Migration 186.';
COMMENT ON FUNCTION public.case_macro_delete(uuid, uuid) IS
  'Deletes a case macro: the owner, or an owner/admin of the workspace for any macro. Another person''s private macro: MACRO_NOT_FOUND. service_role only. Migration 186.';
COMMENT ON FUNCTION public.case_macro_log_apply(uuid, uuid, uuid, jsonb, timestamptz) IS
  'Appends the outcome of one macro apply (the server ran each action through the normal case functions as the actor). Macro visible and case readable, else MACRO_NOT_FOUND / CASE_NOT_FOUND. service_role only. Migration 186.';

-- ---------- 5. RLS ----------

ALTER TABLE public.case_macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_macros FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_macro_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_macro_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_macros_select ON public.case_macros;
CREATE POLICY case_macros_select ON public.case_macros FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (owner_user_id = (SELECT auth.uid()) OR shared));

DROP POLICY IF EXISTS case_macro_log_select ON public.case_macro_log;
CREATE POLICY case_macro_log_select ON public.case_macro_log FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 6. Privileges ----------

REVOKE ALL ON public.case_macros, public.case_macro_log FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_macro_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_macros, public.case_macro_log TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_macro_action_refuse(int, text),
  public.case_macro_validate_actions(jsonb),
  public.case_macro_list(uuid),
  public.case_macro_get(uuid, uuid),
  public.case_macro_save(uuid, uuid, text, jsonb, boolean),
  public.case_macro_delete(uuid, uuid),
  public.case_macro_log_apply(uuid, uuid, uuid, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_macro_list(uuid),
  public.case_macro_get(uuid, uuid),
  public.case_macro_save(uuid, uuid, text, jsonb, boolean),
  public.case_macro_delete(uuid, uuid),
  public.case_macro_log_apply(uuid, uuid, uuid, jsonb, timestamptz)
  TO service_role;

RESET lock_timeout;
