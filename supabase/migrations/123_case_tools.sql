-- ============================================================
-- 123_case_tools.sql — case tools: tasks, document checklist and
-- internal notes on 122's cases. Port of module 018c (018c_tools.sql).
--
--  * Tasks. case_task_templates is config per (account, bank):
--    template_key, title, position, default due in hours. A task
--    (case_tasks: title, owner, due_at, status open | done | blocked)
--    is created only from a template of the case's OWN account and
--    bank (case_task_create; a case with no bank has no templates:
--    TEMPLATE_NOT_FOUND). The owner defaults to the case's agent and
--    must pass case_can_write (OWNER_INVALID). Due = the given due
--    date, else the injected clock + the template's due_hours (NULL
--    when the template has none); infinity / -infinity are refused
--    (DUE_INVALID), a finite past date is allowed. Every status, the
--    initial 'open' included, is a case_task_status_log row. Overdue
--    is never stored: case_task_overdue(actor, now) computes it (due
--    before now and not done; a blocked task past due is overdue)
--    over the tasks of cases the actor may read.
--  * Documents. case_doc_requirements is config per (account, bank,
--    product). A case's requirements come from its own account and
--    bank, matching the product case-insensitively on trimmed text
--    (products arrive as free text from the v1 API); a case with no
--    bank or no product has none. case_documents holds a status
--    (requested | received | rejected) and file_ref, an id of the
--    stored file, never its content: 1..128 of [A-Za-z0-9._:-], not
--    starting with '.', so '.', '..' and dot-files are refused;
--    'received' needs a file_ref. A required document with no row has
--    not been requested; missing = not 'received'.
--    case_doc_request_begin returns what the missing-document message
--    needs (the group, the bank's display name from case_banks.name,
--    the missing keys and labels); case_doc_mark_requested records the
--    request after the send succeeded.
--  * Notes. case_notes is internal (never sent to the customer);
--    mentions are resolved here from the body: @<uuid> in the
--    canonical lowercase 36-char form, stored in case_note_mentions
--    only for a user who passes case_can_write on the case. Every
--    other handle is ignored, not stored, and returned in `ignored`.
--  * Access is the case's: writes need case_rule_can_write of the
--    live case_role (NOT_ALLOWED otherwise, a NULL actor included);
--    reads through RLS follow case_rls_can_read in the caller's
--    active workspace. Config is written only by the account's owner
--    or admin (case_task_template_* / case_doc_requirement_*), for a
--    bank the account has (BANK_UNKNOWN).
--  * Writes: no role writes any of these tables, the service role
--    neither; every write is a SECURITY DEFINER case_* function
--    (search_path ''), called by the app on the service role with
--    p_actor = the signed-in user. The status log, notes and mentions
--    refuse UPDATE / DELETE / TRUNCATE by trigger (owner included);
--    tasks and documents refuse TRUNCATE. User columns hold auth user
--    ids with no FK (history outlives a person).
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
    RAISE EXCEPTION '123 must be applied by a superuser or BYPASSRLS role (the case_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.case_task_templates (
  account_id   uuid    NOT NULL REFERENCES public.accounts(id),
  bank_code    text    NOT NULL,
  template_key text    NOT NULL,
  title        text    NOT NULL,
  position     integer NOT NULL DEFAULT 1,
  due_hours    integer NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_task_templates_pkey PRIMARY KEY (account_id, bank_code, template_key),
  CONSTRAINT case_task_templates_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT case_task_templates_key_check CHECK (template_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT case_task_templates_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  CONSTRAINT case_task_templates_position_check CHECK (position > 0),
  CONSTRAINT case_task_templates_due_hours_check CHECK (due_hours IS NULL OR due_hours > 0)
);

COMMENT ON TABLE public.case_task_templates IS
  'Task templates per (account, bank). Written only through case_task_template_upsert / _delete (owner/admin). Migration 123.';

CREATE TABLE IF NOT EXISTS public.case_doc_requirements (
  account_id uuid    NOT NULL REFERENCES public.accounts(id),
  bank_code  text    NOT NULL,
  product    text    NOT NULL,
  doc_key    text    NOT NULL,
  label      text    NOT NULL,
  position   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_doc_requirements_pkey PRIMARY KEY (account_id, bank_code, product, doc_key),
  CONSTRAINT case_doc_requirements_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT case_doc_requirements_product_check CHECK (btrim(product) <> '' AND char_length(product) <= 200),
  CONSTRAINT case_doc_requirements_key_check CHECK (doc_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT case_doc_requirements_label_check CHECK (btrim(label) <> '' AND char_length(label) <= 200),
  CONSTRAINT case_doc_requirements_position_check CHECK (position > 0)
);
-- Products match case-insensitively on trimmed text, so 'Loan' and
-- ' loan' are one product: one requirement per doc_key among them.
CREATE UNIQUE INDEX IF NOT EXISTS case_doc_requirements_product_ci_key
  ON public.case_doc_requirements (account_id, bank_code, lower(btrim(product)), doc_key);

COMMENT ON TABLE public.case_doc_requirements IS
  'Required documents per (account, bank, product; product case-insensitive, trimmed). Written only through case_doc_requirement_upsert / _delete (owner/admin). Migration 123.';

CREATE TABLE IF NOT EXISTS public.case_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  template_key text NOT NULL,
  title        text NOT NULL,
  owner_id     uuid NOT NULL,
  due_at       timestamptz NULL,
  status       text NOT NULL DEFAULT 'open',
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_tasks_id_account_key UNIQUE (id, account_id),
  CONSTRAINT case_tasks_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_tasks_status_check CHECK (status IN ('open', 'done', 'blocked'))
);
CREATE INDEX IF NOT EXISTS case_tasks_case_idx ON public.case_tasks (case_id, created_at);
CREATE INDEX IF NOT EXISTS case_tasks_due_idx ON public.case_tasks (due_at) WHERE status <> 'done';

CREATE TABLE IF NOT EXISTS public.case_task_status_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     uuid NOT NULL,
  case_id     uuid NOT NULL,
  account_id  uuid NOT NULL,
  from_status text NULL,
  to_status   text NOT NULL,
  actor_id    uuid NOT NULL,
  actor_role  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_task_status_log_task_fkey FOREIGN KEY (task_id, account_id)
    REFERENCES public.case_tasks (id, account_id),
  CONSTRAINT case_task_status_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_task_status_log_task_idx ON public.case_task_status_log (task_id, id);

CREATE TABLE IF NOT EXISTS public.case_documents (
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  doc_key    text NOT NULL,
  status     text NOT NULL,
  file_ref   text NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_documents_pkey PRIMARY KEY (case_id, doc_key),
  CONSTRAINT case_documents_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_documents_status_check CHECK (status IN ('requested', 'received', 'rejected')),
  CONSTRAINT case_documents_file_ref_check
    CHECK (file_ref IS NULL OR file_ref ~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT case_documents_received_has_file CHECK (status <> 'received' OR file_ref IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.case_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  author_id  uuid NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_notes_id_account_key UNIQUE (id, account_id),
  CONSTRAINT case_notes_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  -- [[:space:]], not btrim(): btrim strips spaces only, so a note of tabs
  -- or newlines would pass as non-blank.
  CONSTRAINT case_notes_body_check CHECK (body !~ '^[[:space:]]*$' AND char_length(body) <= 10000)
);
CREATE INDEX IF NOT EXISTS case_notes_case_idx ON public.case_notes (case_id, created_at);

CREATE TABLE IF NOT EXISTS public.case_note_mentions (
  note_id    uuid NOT NULL,
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  CONSTRAINT case_note_mentions_pkey PRIMARY KEY (note_id, user_id),
  CONSTRAINT case_note_mentions_note_fkey FOREIGN KEY (note_id, account_id)
    REFERENCES public.case_notes (id, account_id),
  CONSTRAINT case_note_mentions_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_note_mentions_user_idx ON public.case_note_mentions (user_id);

-- ---------- 2. Integrity (every writer; case_append_only is 122's) ----------

DROP TRIGGER IF EXISTS case_task_status_log_append_only ON public.case_task_status_log;
CREATE TRIGGER case_task_status_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_task_status_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_task_status_log_no_truncate ON public.case_task_status_log;
CREATE TRIGGER case_task_status_log_no_truncate
  BEFORE TRUNCATE ON public.case_task_status_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_notes_append_only ON public.case_notes;
CREATE TRIGGER case_notes_append_only
  BEFORE UPDATE OR DELETE ON public.case_notes
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_notes_no_truncate ON public.case_notes;
CREATE TRIGGER case_notes_no_truncate
  BEFORE TRUNCATE ON public.case_notes
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_note_mentions_append_only ON public.case_note_mentions;
CREATE TRIGGER case_note_mentions_append_only
  BEFORE UPDATE OR DELETE ON public.case_note_mentions
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_note_mentions_no_truncate ON public.case_note_mentions;
CREATE TRIGGER case_note_mentions_no_truncate
  BEFORE TRUNCATE ON public.case_note_mentions
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_tasks_no_truncate ON public.case_tasks;
CREATE TRIGGER case_tasks_no_truncate
  BEFORE TRUNCATE ON public.case_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_documents_no_truncate ON public.case_documents;
CREATE TRIGGER case_documents_no_truncate
  BEFORE TRUNCATE ON public.case_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 3. Helper ----------

-- Locks the case (FOR SHARE) for a write by p_actor; raises
-- CASE_NOT_FOUND / NOT_ALLOWED. Returns the actor's live case role.
CREATE OR REPLACE FUNCTION public.case_tools_lock_for_write(p_case uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change it', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN v_role;
END;
$$;

-- ---------- 4. Tasks ----------

-- Creates a task from a template of the case's own account and bank.
-- Owner defaults to the case's agent and must pass case_can_write;
-- due defaults to p_now (else now()) + the template's due_hours.
-- Returns the task id.
CREATE OR REPLACE FUNCTION public.case_task_create(p_case uuid, p_actor uuid, p_template_key text,
  p_owner uuid DEFAULT NULL, p_due_at timestamptz DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role  text;
  c       public.cases%ROWTYPE;
  t       public.case_task_templates%ROWTYPE;
  v_owner uuid;
  v_now   timestamptz := coalesce(p_now, now());
  v_due   timestamptz;
  v_id    uuid;
BEGIN
  v_role := public.case_tools_lock_for_write(p_case, p_actor);
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  SELECT * INTO t FROM public.case_task_templates x
   WHERE x.account_id = c.account_id AND x.bank_code = c.bank_code AND x.template_key = p_template_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no task template % for bank % in this workspace', p_template_key, coalesce(c.bank_code, '(none)')
      USING ERRCODE = 'no_data_found', HINT = 'TEMPLATE_NOT_FOUND';
  END IF;
  v_owner := coalesce(p_owner, c.agent_id);
  IF NOT public.case_can_write(p_case, v_owner) THEN
    RAISE EXCEPTION 'user % may not own a task of case %', v_owner, p_case
      USING ERRCODE = 'check_violation', HINT = 'OWNER_INVALID';
  END IF;
  v_due := coalesce(p_due_at, v_now + make_interval(hours => t.due_hours));
  -- A finite past due date is allowed (a task may be created already
  -- overdue); infinity / -infinity never is.
  IF v_due IS NOT NULL AND NOT isfinite(v_due) THEN
    RAISE EXCEPTION 'a task needs a finite due date' USING ERRCODE = 'check_violation', HINT = 'DUE_INVALID';
  END IF;
  INSERT INTO public.case_tasks (case_id, account_id, template_key, title, owner_id, due_at, status,
                                 created_by, created_at, updated_at)
  VALUES (p_case, c.account_id, t.template_key, t.title, v_owner, v_due, 'open', p_actor, v_now, v_now)
  RETURNING id INTO v_id;
  INSERT INTO public.case_task_status_log (task_id, case_id, account_id, from_status, to_status,
                                           actor_id, actor_role, changed_at)
  VALUES (v_id, p_case, c.account_id, NULL, 'open', p_actor, v_role, v_now);
  RETURN v_id;
END;
$$;

-- Changes a task's status, logged. Same status: no-op (changed =
-- false), nothing logged.
CREATE OR REPLACE FUNCTION public.case_task_set_status(p_task uuid, p_actor uuid, p_status text,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (changed boolean, from_status text, to_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t      public.case_tasks%ROWTYPE;
  v_role text;
  v_now  timestamptz := coalesce(p_now, now());
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('open', 'done', 'blocked') THEN
    RAISE EXCEPTION 'task status % is not open, done or blocked', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  SELECT * INTO t FROM public.case_tasks x WHERE x.id = p_task;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task % not found', p_task USING ERRCODE = 'no_data_found', HINT = 'TASK_NOT_FOUND';
  END IF;
  v_role := public.case_tools_lock_for_write(t.case_id, p_actor);
  SELECT * INTO t FROM public.case_tasks x WHERE x.id = p_task FOR UPDATE;
  IF t.status = p_status THEN
    RETURN QUERY SELECT false, t.status, t.status;
    RETURN;
  END IF;
  UPDATE public.case_tasks x SET status = p_status, updated_at = v_now WHERE x.id = p_task;
  INSERT INTO public.case_task_status_log (task_id, case_id, account_id, from_status, to_status,
                                           actor_id, actor_role, changed_at)
  VALUES (p_task, t.case_id, t.account_id, t.status, p_status, p_actor, v_role, v_now);
  RETURN QUERY SELECT true, t.status, p_status;
END;
$$;

-- Overdue, computed from the injected clock (never stored): tasks of
-- cases p_actor may read that are not done and due before p_now.
CREATE OR REPLACE FUNCTION public.case_task_overdue(p_actor uuid, p_now timestamptz)
RETURNS TABLE (task_id uuid, case_id uuid, title text, owner_id uuid, due_at timestamptz, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'case_task_overdue needs the clock' USING ERRCODE = 'null_value_not_allowed', HINT = 'NOW_REQUIRED';
  END IF;
  RETURN QUERY
    SELECT t.id, t.case_id, t.title, t.owner_id, t.due_at, t.status
      FROM public.case_tasks t
     WHERE t.status <> 'done' AND t.due_at IS NOT NULL AND t.due_at < p_now
       AND public.case_can_read(t.case_id, p_actor)
     ORDER BY t.due_at, t.id;
END;
$$;

-- ---------- 5. Documents ----------

-- Sets a required document's status. 'received' needs a file reference
-- (an id; the content is never stored here). Returns the status.
CREATE OR REPLACE FUNCTION public.case_doc_set_status(p_case uuid, p_actor uuid, p_doc_key text, p_status text,
  p_file_ref text DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c     public.cases%ROWTYPE;
  v_now timestamptz := coalesce(p_now, now());
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  IF p_status IS NULL OR p_status NOT IN ('requested', 'received', 'rejected') THEN
    RAISE EXCEPTION 'document status % is not requested, received or rejected', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT EXISTS (SELECT 1 FROM public.case_doc_requirements r
                  WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
                    AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = p_doc_key) THEN
    RAISE EXCEPTION 'document % is not required for bank % / %', p_doc_key, coalesce(c.bank_code, '(none)'),
      coalesce(c.product, '(none)') USING ERRCODE = 'check_violation', HINT = 'DOC_NOT_REQUIRED';
  END IF;
  IF p_file_ref IS NOT NULL AND p_file_ref !~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'file reference is not an id' USING ERRCODE = 'check_violation', HINT = 'FILE_REF_INVALID';
  END IF;
  IF p_status = 'received' AND p_file_ref IS NULL THEN
    RAISE EXCEPTION 'a received document needs its file reference'
      USING ERRCODE = 'check_violation', HINT = 'FILE_REF_REQUIRED';
  END IF;
  INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
  VALUES (p_case, c.account_id, p_doc_key, p_status, p_file_ref, p_actor, v_now)
  ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
    SET status = EXCLUDED.status, file_ref = EXCLUDED.file_ref,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN p_status;
END;
$$;

-- What the missing-document request needs, for an actor who may act on
-- the case: always one row — the case's account and group, the
-- group's submission_ref, the bank's display name (case_banks.name;
-- NULL for a case with no bank) and the required documents not yet
-- received, in position order (empty for a case with no bank or
-- product).
CREATE OR REPLACE FUNCTION public.case_doc_request_begin(p_case uuid, p_actor uuid)
RETURNS TABLE (account_id uuid, group_id uuid, submission_ref text, bank_name text,
               doc_keys text[], doc_labels text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  RETURN QUERY
    SELECT c.account_id, c.group_id,
           (SELECT g.submission_ref FROM public.submission_groups g WHERE g.id = c.group_id),
           (SELECT coalesce(nullif(b.name, ''), b.code) FROM public.case_banks b
             WHERE b.account_id = c.account_id AND b.code = c.bank_code),
           coalesce(array_agg(r.doc_key ORDER BY r.position, r.doc_key), '{}'::text[]),
           coalesce(array_agg(r.label ORDER BY r.position, r.doc_key), '{}'::text[])
      FROM public.case_doc_requirements r
     WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
       AND lower(btrim(r.product)) = lower(btrim(c.product))
       AND NOT EXISTS (SELECT 1 FROM public.case_documents d
                        WHERE d.case_id = c.id AND d.doc_key = r.doc_key AND d.status = 'received');
END;
$$;

-- After the request was sent: every listed required document that is
-- not received becomes 'requested'. Returns how many rows it wrote.
CREATE OR REPLACE FUNCTION public.case_doc_mark_requested(p_case uuid, p_actor uuid, p_doc_keys text[],
  p_now timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c   public.cases%ROWTYPE;
  v_n integer;
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
  SELECT p_case, c.account_id, r.doc_key, 'requested', NULL, p_actor, coalesce(p_now, now())
    FROM public.case_doc_requirements r
   WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
     AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = ANY (p_doc_keys)
  ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
    SET status = 'requested', file_ref = NULL, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    WHERE d.status <> 'received';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------- 6. Notes ----------

-- Adds an internal note (1..10000 chars, not blank). Mentions are
-- @<uuid> in canonical lowercase form, stored only for users who pass
-- case_can_write; every other handle is ignored (returned, not stored).
-- Returns the note id, the mentioned user ids and the ignored handles.
CREATE OR REPLACE FUNCTION public.case_note_add(p_case uuid, p_actor uuid, p_body text,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (note_id uuid, mentioned uuid[], ignored text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_id      uuid;
  v_handles text[];
  v_ok      uuid[];
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  IF p_body IS NULL OR p_body ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'note is empty' USING ERRCODE = 'check_violation', HINT = 'NOTE_EMPTY';
  END IF;
  IF char_length(p_body) > 10000 THEN
    RAISE EXCEPTION 'note is longer than 10000 characters' USING ERRCODE = 'check_violation', HINT = 'NOTE_TOO_LONG';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  INSERT INTO public.case_notes (case_id, account_id, author_id, body, created_at)
  VALUES (p_case, c.account_id, p_actor, p_body, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  -- Trailing '.' / '-' are sentence punctuation ("thanks @<uuid>."), so
  -- they are stripped; a uuid never ends with either.
  SELECT coalesce(array_agg(DISTINCT h), '{}'::text[]) INTO v_handles
    FROM (SELECT regexp_replace(m[1], '[.-]+$', '') AS h
            FROM regexp_matches(p_body, '@([A-Za-z0-9_.-]+)', 'g') AS m) x
   WHERE h <> '';
  SELECT coalesce(array_agg(h::uuid ORDER BY h), '{}'::uuid[]) INTO v_ok
    FROM unnest(v_handles) AS h
   WHERE h ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND public.case_can_write(p_case, h::uuid);
  INSERT INTO public.case_note_mentions (note_id, case_id, account_id, user_id)
  SELECT v_id, p_case, c.account_id, u FROM unnest(v_ok) AS u;
  RETURN QUERY SELECT v_id, v_ok,
    coalesce((SELECT array_agg(h ORDER BY h) FROM unnest(v_handles) AS h
               WHERE NOT (h = ANY (SELECT u::text FROM unnest(v_ok) AS u))), '{}'::text[]);
END;
$$;

-- ---------- 7. Configuration (owner/admin of the account) ----------

-- Adds or updates a task template of a bank (position NULL = 1,
-- due_hours NULL = no default due date). Returns the stored row.
CREATE OR REPLACE FUNCTION public.case_task_template_upsert(p_actor uuid, p_account uuid, p_bank_code text,
  p_template_key text, p_title text, p_position int, p_due_hours int)
RETURNS public.case_task_templates
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.case_task_templates%ROWTYPE;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure task templates of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  INSERT INTO public.case_task_templates AS t (account_id, bank_code, template_key, title, position, due_hours)
  VALUES (p_account, p_bank_code, p_template_key, p_title, coalesce(p_position, 1), p_due_hours)
  ON CONFLICT ON CONSTRAINT case_task_templates_pkey
  DO UPDATE SET title = EXCLUDED.title, position = EXCLUDED.position, due_hours = EXCLUDED.due_hours,
                updated_at = now()
  RETURNING t.* INTO v_row;
  RETURN v_row;
END;
$$;

-- Deletes a task template; tasks made from it keep their own title.
-- Returns whether a row was deleted.
CREATE OR REPLACE FUNCTION public.case_task_template_delete(p_actor uuid, p_account uuid, p_bank_code text,
  p_template_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure task templates of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  DELETE FROM public.case_task_templates t
   WHERE t.account_id = p_account AND t.bank_code = p_bank_code AND t.template_key = p_template_key;
  RETURN FOUND;
END;
$$;

-- Adds or updates a required document of a (bank, product). The
-- product is stored trimmed and matched case-insensitively, so an
-- update keeps the first spelling (position NULL = 1). Returns the row.
CREATE OR REPLACE FUNCTION public.case_doc_requirement_upsert(p_actor uuid, p_account uuid, p_bank_code text,
  p_product text, p_doc_key text, p_label text, p_position int)
RETURNS public.case_doc_requirements
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.case_doc_requirements%ROWTYPE;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure document requirements of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  INSERT INTO public.case_doc_requirements AS r (account_id, bank_code, product, doc_key, label, position)
  VALUES (p_account, p_bank_code, btrim(p_product), p_doc_key, p_label, coalesce(p_position, 1))
  ON CONFLICT (account_id, bank_code, (lower(btrim(product))), doc_key)
  DO UPDATE SET label = EXCLUDED.label, position = EXCLUDED.position, updated_at = now()
  RETURNING r.* INTO v_row;
  RETURN v_row;
END;
$$;

-- Deletes a required document of a (bank, product; case-insensitive).
-- Document rows already recorded for it stay. Returns whether a row
-- was deleted.
CREATE OR REPLACE FUNCTION public.case_doc_requirement_delete(p_actor uuid, p_account uuid, p_bank_code text,
  p_product text, p_doc_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure document requirements of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  DELETE FROM public.case_doc_requirements r
   WHERE r.account_id = p_account AND r.bank_code = p_bank_code
     AND lower(btrim(r.product)) = lower(btrim(p_product)) AND r.doc_key = p_doc_key;
  RETURN FOUND;
END;
$$;

-- ---------- 8. Row-level security ----------

ALTER TABLE public.case_task_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_task_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_doc_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_doc_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_task_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_task_status_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_note_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_note_mentions FORCE ROW LEVEL SECURITY;

-- SELECT only: config to members of the active workspace, the rest
-- to whoever reads the case.
DROP POLICY IF EXISTS case_task_templates_select ON public.case_task_templates;
CREATE POLICY case_task_templates_select ON public.case_task_templates FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS case_doc_requirements_select ON public.case_doc_requirements;
CREATE POLICY case_doc_requirements_select ON public.case_doc_requirements FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS case_tasks_select ON public.case_tasks;
CREATE POLICY case_tasks_select ON public.case_tasks FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_task_status_log_select ON public.case_task_status_log;
CREATE POLICY case_task_status_log_select ON public.case_task_status_log FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_documents_select ON public.case_documents;
CREATE POLICY case_documents_select ON public.case_documents FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_notes_select ON public.case_notes;
CREATE POLICY case_notes_select ON public.case_notes FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_note_mentions_select ON public.case_note_mentions;
CREATE POLICY case_note_mentions_select ON public.case_note_mentions FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 9. Privileges ----------

-- Start from nothing, then the minimum: reads to authenticated (under
-- RLS) and the service role, writes to nobody.
REVOKE ALL ON public.case_task_templates, public.case_doc_requirements, public.case_tasks,
  public.case_task_status_log, public.case_documents, public.case_notes, public.case_note_mentions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_task_status_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_task_templates, public.case_doc_requirements, public.case_tasks,
  public.case_task_status_log, public.case_documents, public.case_notes, public.case_note_mentions
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_tools_lock_for_write(uuid, uuid),
  public.case_task_create(uuid, uuid, text, uuid, timestamptz, timestamptz),
  public.case_task_set_status(uuid, uuid, text, timestamptz),
  public.case_task_overdue(uuid, timestamptz),
  public.case_doc_set_status(uuid, uuid, text, text, text, timestamptz),
  public.case_doc_request_begin(uuid, uuid),
  public.case_doc_mark_requested(uuid, uuid, text[], timestamptz),
  public.case_note_add(uuid, uuid, text, timestamptz),
  public.case_task_template_upsert(uuid, uuid, text, text, text, int, int),
  public.case_task_template_delete(uuid, uuid, text, text),
  public.case_doc_requirement_upsert(uuid, uuid, text, text, text, text, int),
  public.case_doc_requirement_delete(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_tools_lock_for_write(uuid, uuid),
  public.case_task_create(uuid, uuid, text, uuid, timestamptz, timestamptz),
  public.case_task_set_status(uuid, uuid, text, timestamptz),
  public.case_task_overdue(uuid, timestamptz),
  public.case_doc_set_status(uuid, uuid, text, text, text, timestamptz),
  public.case_doc_request_begin(uuid, uuid),
  public.case_doc_mark_requested(uuid, uuid, text[], timestamptz),
  public.case_note_add(uuid, uuid, text, timestamptz),
  public.case_task_template_upsert(uuid, uuid, text, text, text, int, int),
  public.case_task_template_delete(uuid, uuid, text, text),
  public.case_doc_requirement_upsert(uuid, uuid, text, text, text, text, int),
  public.case_doc_requirement_delete(uuid, uuid, text, text, text)
  TO service_role;

RESET lock_timeout;
