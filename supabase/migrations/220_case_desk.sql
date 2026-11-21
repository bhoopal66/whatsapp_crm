-- ============================================================
-- 220_case_desk.sql — the case desk: human case numbers and the
-- staff intake with its sorting queue. Port of package modules 035a
-- (case desk core) and 035b (intake), shaped to this repo:
--
--  * Not ported, already here: the package's bank_desks and 035d's
--    desk visibility. A coordinator is a live agent / team_leader
--    holding a bank (133's coordinator_banks), and 161's case_role
--    already makes them 'coordinator' on that bank's cases. The
--    sorting queue reads the same rule (case_holds_bank). 035e (judge
--    shadow) duplicates the Jev selection judgments and is not ported.
--  * A company is a desk_customers row keyed by its normalised trade
--    licence (upper-case, spaces and dashes removed), one live row per
--    (account, licence). A request is a desk_applications row numbered
--    'TC-YY-NNNNN' from ONE counter per account (desk_number_seq) that
--    never restarts by year; YY is the opening year in Asia/Dubai,
--    display only. Gapless: the counter row is locked in the same
--    transaction as the insert. At most one open application per
--    company.
--  * A desk case is an ordinary 130 lead (case_open_lead) of a CRM
--    contact, stamped with desk_application_id, desk_customer_id and
--    case_number 'TC-YY-NNNNN-BBB' (BBB = the bank's three-letter desk
--    code, desk_bank_codes; a second case of the application at the same
--    bank BBB2 .. BBB9). It needs a contact because every case file
--    lives in the contact's folder (178-181). Existing cases keep NULL
--    desk columns.
--  * Caption code = seq without leading zeros + BBB(+digit) + one check
--    character (Luhn mod 36 over NNNNN + BBB(+digit), alphabet 0-9A-Z),
--    e.g. '1RAK' + check. Any single mistyped character is refused
--    rather than filing a document to the wrong case. src/lib/desk/
--    case-number.ts is the identical TS; verify-case-desk.sql and
--    case-number.test.ts pin the same vectors.
--  * intake_items: one row per staff upload, idempotent per (account,
--    uploader, idem_key). Complete tags file at once: a pending document
--    or info with a case number / caption code goes to that open case; a
--    new case with bank, company, licence, product and contact opens (or
--    joins, same legal name only) the company's case at that bank.
--    Anything else waits 'untagged' in the bank's sorting queue (or the
--    team-lead queue when no bank is known) with a reason. State changes
--    only through intake_set_state, which appends one intake_item_events
--    row each time (append-only).
--  * A file's bytes are stored by the app in the private 'case-files'
--    bucket at 'intake/<item id>/<sha256>.<ext>' before intake_submit.
--    Filing records it as the uploader's staff_upload customer document
--    (180) and registers it on the case directly (registered_by = the
--    uploader): an agent who holds the case code may upload to a case
--    that is not theirs, the code being the proof. The same bytes filed
--    twice to one case become 'duplicate' (advisory lock on case+sha256).
--  * Who: any live staff member (agent and up) uploads and sees their
--    own uploads; sorting is for owners / admins / team leaders (every
--    queue) and the holders of a bank (that bank's queue only; the
--    no-bank queue is team leaders and up). Only the uploader retags,
--    and only while untagged. A desk case is opened in the UPLOADER's
--    name (the agent); a sorter holding the bank is named coordinator.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, BANK_UNKNOWN, BANK_CODE_MISSING,
-- CODE_TAKEN, SEQ_EXHAUSTED, SUFFIX_EXHAUSTED, CASE_CONFLICT, NO_CONTACT,
-- FILE_INVALID, ITEM_NOT_FOUND, ITEM_NOT_OPEN, BANK_SCOPE, CASE_NOT_FOUND,
-- CASE_CLOSED, NO_FILE, REASON_REQUIRED, and case_open_lead's
-- (LEAD_INVALID, LEAD_EXISTS, CASE_EXISTS, ASSIGNEE_INVALID).
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only. New
-- tables force RLS with no policy and no grants: the API routes check the
-- caller's active account and call the functions on the service role.
-- Apply as a superuser or BYPASSRLS role (the functions read RLS-forced
-- tables as their owner). Re-runnable. Asserted by
-- supabase/ci/verify-case-desk.sql. docs/case-desk.md is the contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '220 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.desk_bank_codes (
  account_id uuid NOT NULL,
  bank_code  text NOT NULL,
  short_code text NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_bank_codes_pkey PRIMARY KEY (account_id, bank_code),
  CONSTRAINT desk_bank_codes_short_uq UNIQUE (account_id, short_code),
  CONSTRAINT desk_bank_codes_short_check CHECK (short_code ~ '^[A-Z]{3}$'),
  CONSTRAINT desk_bank_codes_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code)
);
COMMENT ON TABLE public.desk_bank_codes IS
  'The three-letter desk code of a bank, used in case numbers and captions. Written only through desk_bank_code_set. Migration 220.';

CREATE TABLE IF NOT EXISTS public.desk_customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id),
  trade_licence_no text NOT NULL,
  legal_name       text NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  merged_into      uuid NULL REFERENCES public.desk_customers(id),
  CONSTRAINT desk_customers_id_account_key UNIQUE (id, account_id),
  CONSTRAINT desk_customers_licence_check CHECK (trade_licence_no ~ '^[A-Z0-9/.]{1,64}$'),
  CONSTRAINT desk_customers_name_check
    CHECK (legal_name !~ '^[[:space:]]*$' AND char_length(legal_name) <= 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_customers_one_live_licence
  ON public.desk_customers (account_id, trade_licence_no) WHERE merged_into IS NULL;
COMMENT ON TABLE public.desk_customers IS
  'A company (trade licence) the desk opens cases for. merged_into is reserved (no merge function yet). Migration 220.';

CREATE TABLE IF NOT EXISTS public.desk_number_seq (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id),
  next_val   integer NOT NULL DEFAULT 1,
  CONSTRAINT desk_number_seq_check CHECK (next_val BETWEEN 1 AND 10000000)
);
COMMENT ON TABLE public.desk_number_seq IS
  'One application counter per account; never restarts by year. Migration 220.';

CREATE TABLE IF NOT EXISTS public.desk_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  yy            integer NOT NULL,
  seq           integer NOT NULL,
  app_number    text NOT NULL,
  owner_user_id uuid NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_applications_customer_fkey FOREIGN KEY (customer_id, account_id)
    REFERENCES public.desk_customers (id, account_id),
  CONSTRAINT desk_applications_number_uq UNIQUE (account_id, app_number),
  CONSTRAINT desk_applications_seq_uq UNIQUE (account_id, seq),
  CONSTRAINT desk_applications_id_customer_key UNIQUE (id, customer_id),
  CONSTRAINT desk_applications_yy_check CHECK (yy BETWEEN 0 AND 99),
  CONSTRAINT desk_applications_seq_check CHECK (seq BETWEEN 1 AND 9999999),
  CONSTRAINT desk_applications_number_check
    CHECK (app_number ~ '^TC-[0-9]{2}-([0-9]{5}|[1-9][0-9]{5,6})$'),
  CONSTRAINT desk_applications_status_check CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_applications_one_open_per_customer
  ON public.desk_applications (customer_id) WHERE status = 'open';
COMMENT ON TABLE public.desk_applications IS
  'One company request, numbered TC-YY-NNNNN. No function closes one yet. Migration 220.';

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS desk_application_id uuid NULL;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS desk_customer_id uuid NULL;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS case_number text NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_desk_application_fkey') THEN
    ALTER TABLE public.cases ADD CONSTRAINT cases_desk_application_fkey
      FOREIGN KEY (desk_application_id, desk_customer_id)
      REFERENCES public.desk_applications (id, customer_id);
  END IF;
END $$;
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_desk_columns_together;
ALTER TABLE public.cases ADD CONSTRAINT cases_desk_columns_together CHECK (
  (desk_application_id IS NULL AND desk_customer_id IS NULL AND case_number IS NULL)
  OR (desk_application_id IS NOT NULL AND desk_customer_id IS NOT NULL AND case_number IS NOT NULL));
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_case_number_format;
ALTER TABLE public.cases ADD CONSTRAINT cases_case_number_format CHECK (
  case_number IS NULL OR case_number ~ '^TC-[0-9]{2}-([0-9]{5}|[1-9][0-9]{5,6})-[A-Z]{3}[2-9]?$');
CREATE UNIQUE INDEX IF NOT EXISTS cases_account_case_number
  ON public.cases (account_id, case_number) WHERE case_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS cases_desk_application_idx
  ON public.cases (desk_application_id, bank_code) WHERE desk_application_id IS NOT NULL;
COMMENT ON COLUMN public.cases.case_number IS
  'The desk number TC-YY-NNNNN-BBB(2-9); NULL for cases not opened by the desk. Migration 220.';

CREATE TABLE IF NOT EXISTS public.intake_items (
  id                uuid PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES public.accounts(id),
  uploaded_by       uuid NOT NULL,
  idem_key          text NOT NULL,
  channel           text NOT NULL DEFAULT 'wacrm',
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- tags as submitted (retag replaces them; the event keeps the old ones)
  kind              text NULL,
  bank_code         text NULL,
  case_ref          text NULL,
  company_name      text NULL,
  trade_licence_no  text NULL,
  product           text NULL,
  contact_id        uuid NULL,
  doc_key           text NULL,
  note              text NULL,
  -- the file, all or none (bytes in the 'case-files' bucket)
  storage_path      text NULL,
  original_name     text NULL,
  mime              text NULL,
  size_bytes        bigint NULL,
  sha256            text NULL,
  -- current state
  state             text NOT NULL DEFAULT 'untagged',
  queue_bank_code   text NULL,
  queue_reason      text NULL,
  filed_case_id     uuid NULL,
  filed_kind        text NULL,
  filed_doc_key     text NULL,
  file_id           uuid NULL REFERENCES public.case_document_files(id),
  duplicate_of_item uuid NULL REFERENCES public.intake_items(id),
  decided_by        uuid NULL,
  decided_at        timestamptz NULL,
  reject_reason     text NULL,
  CONSTRAINT intake_items_idem_uq UNIQUE (account_id, uploaded_by, idem_key),
  CONSTRAINT intake_items_idem_check CHECK (char_length(idem_key) BETWEEN 8 AND 80 AND idem_key ~ '^[A-Za-z0-9_:.-]+$'),
  CONSTRAINT intake_items_channel_check CHECK (channel IN ('wacrm', 'whatsapp')),
  CONSTRAINT intake_items_kind_check CHECK (kind IS NULL OR kind IN ('new_case', 'pending_doc', 'info')),
  CONSTRAINT intake_items_filed_kind_check
    CHECK (filed_kind IS NULL OR filed_kind IN ('new_case', 'pending_doc', 'info')),
  CONSTRAINT intake_items_doc_key_check CHECK (doc_key IS NULL OR doc_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT intake_items_filed_doc_key_check CHECK (filed_doc_key IS NULL OR filed_doc_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT intake_items_text_check CHECK (
    (note IS NULL OR char_length(note) <= 4000)
    AND (case_ref IS NULL OR char_length(case_ref) <= 40)
    AND (company_name IS NULL OR char_length(company_name) <= 200)
    AND (trade_licence_no IS NULL OR char_length(trade_licence_no) <= 64)
    AND (product IS NULL OR char_length(product) <= 200)
    AND (reject_reason IS NULL OR char_length(reject_reason) <= 500)),
  CONSTRAINT intake_items_file_meta CHECK (
    (storage_path IS NULL AND original_name IS NULL AND mime IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
    OR (storage_path IS NOT NULL AND original_name IS NOT NULL AND mime IS NOT NULL
        AND size_bytes > 0 AND sha256 ~ '^[0-9a-f]{64}$'
        AND mime IN ('application/pdf', 'image/jpeg', 'image/png')
        AND storage_path = 'intake/' || id::text || '/' || sha256 || '.'
            || CASE mime WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' ELSE 'png' END)),
  CONSTRAINT intake_items_state_check CHECK (state IN ('untagged', 'filed', 'rejected', 'duplicate')),
  CONSTRAINT intake_items_state_cols CHECK (
    (state = 'untagged' AND filed_case_id IS NULL AND file_id IS NULL)
    OR (state = 'filed' AND filed_case_id IS NOT NULL AND filed_kind IS NOT NULL
        AND (file_id IS NOT NULL) = (sha256 IS NOT NULL))
    OR (state = 'duplicate' AND filed_case_id IS NOT NULL AND file_id IS NULL AND sha256 IS NOT NULL)
    OR (state = 'rejected' AND file_id IS NULL AND reject_reason !~ '^[[:space:]]*$')),
  CONSTRAINT intake_items_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT intake_items_queue_bank_fkey FOREIGN KEY (account_id, queue_bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT intake_items_case_fkey FOREIGN KEY (filed_case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT intake_items_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX IF NOT EXISTS intake_items_queue_idx
  ON public.intake_items (account_id, queue_bank_code, received_at) WHERE state = 'untagged';
CREATE INDEX IF NOT EXISTS intake_items_case_sha_idx
  ON public.intake_items (filed_case_id, sha256) WHERE filed_case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intake_items_uploader_idx
  ON public.intake_items (account_id, uploaded_by, received_at DESC);
COMMENT ON TABLE public.intake_items IS
  'One staff upload to the case desk: its tags, optional file and state. State changes only through intake_set_state. Migration 220.';

CREATE TABLE IF NOT EXISTS public.intake_item_events (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id  uuid NOT NULL REFERENCES public.intake_items(id),
  at       timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL,
  state    text NOT NULL,
  case_id  uuid NULL,
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT intake_item_events_state_check CHECK (state IN ('untagged', 'filed', 'rejected', 'duplicate'))
);
CREATE INDEX IF NOT EXISTS intake_item_events_item_idx ON public.intake_item_events (item_id, id);
COMMENT ON TABLE public.intake_item_events IS
  'Append-only log of every intake item state change, the first included. Migration 220.';

DROP TRIGGER IF EXISTS intake_item_events_no_update ON public.intake_item_events;
CREATE TRIGGER intake_item_events_no_update BEFORE UPDATE ON public.intake_item_events
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS intake_item_events_no_delete ON public.intake_item_events;
CREATE TRIGGER intake_item_events_no_delete BEFORE DELETE ON public.intake_item_events
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS intake_item_events_no_truncate ON public.intake_item_events;
CREATE TRIGGER intake_item_events_no_truncate BEFORE TRUNCATE ON public.intake_item_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['desk_bank_codes', 'desk_customers', 'desk_number_seq', 'desk_applications',
                           'intake_items', 'intake_item_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;

-- ---------- 2. Numbering (pure) ----------

CREATE OR REPLACE FUNCTION public.desk_check_char(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  a  constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  f  integer := 2;
  s  integer := 0;
  i  integer;
  ad integer;
BEGIN
  IF p IS NULL OR p !~ '^[0-9A-Z]+$' THEN
    RETURN NULL;
  END IF;
  FOR i IN REVERSE length(p)..1 LOOP
    ad := f * (strpos(a, substr(p, i, 1)) - 1);
    s := s + (ad / 36) + (ad % 36);
    f := 3 - f;
  END LOOP;
  RETURN substr(a, ((36 - (s % 36)) % 36) + 1, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_pad_seq(p_seq integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT lpad(p_seq::text, greatest(5, length(p_seq::text)), '0') $$;

CREATE OR REPLACE FUNCTION public.desk_case_number(p_yy integer, p_seq integer, p_bank_part text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT 'TC-' || lpad(p_yy::text, 2, '0') || '-' || public.desk_pad_seq(p_seq) || '-' || p_bank_part $$;

-- The check covers NNNNN + bank part only: every character it covers is
-- in the caption code, so a one-character typo never resolves.
CREATE OR REPLACE FUNCTION public.desk_caption_code(p_seq integer, p_bank_part text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_seq::text || p_bank_part || public.desk_check_char(public.desk_pad_seq(p_seq) || p_bank_part)
$$;

CREATE OR REPLACE FUNCTION public.desk_normalise_licence(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT upper(regexp_replace(coalesce(p, ''), '[[:space:]-]', '', 'g')) $$;

CREATE OR REPLACE FUNCTION public.desk_normalise_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT lower(btrim(regexp_replace(coalesce(p, ''), '[[:space:]]+', ' ', 'g'))) $$;

CREATE OR REPLACE FUNCTION public.desk_blank(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT p IS NULL OR p ~ '^[[:space:]]*$' $$;

-- Trimmed text, NULL when blank (a tab or newline counts as blank).
CREATE OR REPLACE FUNCTION public.desk_clean(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN public.desk_blank(p) THEN NULL
              ELSE regexp_replace(p, '^[[:space:]]+|[[:space:]]+$', '', 'g') END
$$;

CREATE OR REPLACE FUNCTION public.desk_refuse(p_fn text, p_hint text, p_msg text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '%: %', p_fn, p_msg USING ERRCODE = 'check_violation', HINT = p_hint;
END;
$$;

-- ---------- 3. Who ----------

-- owner / admin / any team leader sort every queue; a holder of a bank
-- (161) sorts that bank's queue. NULL bank = the team-lead queue.
CREATE OR REPLACE FUNCTION public.intake_scope_ok(p_actor uuid, p_account uuid, p_bank_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)
      OR (p_bank_code IS NOT NULL AND public.case_holds_bank(p_account, p_actor, p_bank_code))
$$;

-- May p_actor sort at all (any queue)?
CREATE OR REPLACE FUNCTION public.intake_is_sorter(p_actor uuid, p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)
      OR EXISTS (SELECT 1 FROM public.coordinator_banks b
                  WHERE b.account_id = p_account AND b.user_id = p_actor
                    AND public.case_holds_bank(p_account, p_actor, b.bank_code))
$$;

-- ---------- 4. Bank codes ----------

CREATE OR REPLACE FUNCTION public.desk_bank_code_set(p_actor uuid, p_account uuid, p_bank_code text, p_short text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_short text := upper(coalesce(public.desk_clean(p_short), ''));
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('admin', 'super_admin') THEN
    PERFORM public.desk_refuse('desk_bank_code_set', 'NOT_ALLOWED', 'only an owner or admin sets desk codes');
  END IF;
  IF v_short !~ '^[A-Z]{3}$' THEN
    PERFORM public.desk_refuse('desk_bank_code_set', 'INVALID', 'desk code: three letters A-Z');
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.desk_refuse('desk_bank_code_set', 'BANK_UNKNOWN', 'not a bank of this workspace');
  END IF;
  IF EXISTS (SELECT 1 FROM public.desk_bank_codes x
              WHERE x.account_id = p_account AND x.short_code = v_short AND x.bank_code <> p_bank_code) THEN
    PERFORM public.desk_refuse('desk_bank_code_set', 'CODE_TAKEN', 'desk code already used by another bank');
  END IF;
  -- A bank whose code is in a case number keeps it: the numbers would no
  -- longer resolve.
  IF EXISTS (SELECT 1 FROM public.desk_bank_codes x
              WHERE x.account_id = p_account AND x.bank_code = p_bank_code AND x.short_code <> v_short)
     AND EXISTS (SELECT 1 FROM public.cases c
                  WHERE c.account_id = p_account AND c.bank_code = p_bank_code AND c.case_number IS NOT NULL) THEN
    PERFORM public.desk_refuse('desk_bank_code_set', 'CODE_TAKEN', 'the bank already has numbered cases; its code is fixed');
  END IF;
  INSERT INTO public.desk_bank_codes (account_id, bank_code, short_code, updated_by, updated_at)
  VALUES (p_account, p_bank_code, v_short, p_actor, now())
  ON CONFLICT ON CONSTRAINT desk_bank_codes_pkey
  DO UPDATE SET short_code = excluded.short_code, updated_by = excluded.updated_by, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_bank_by_short(p_account uuid, p_short text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT x.bank_code FROM public.desk_bank_codes x
   WHERE x.account_id = p_account AND x.short_code = upper(coalesce(public.desk_clean(p_short), ''))
$$;

-- Every bank of the account with its desk code (NULL when none): the
-- upload form's bank list and the Settings editor.
CREATE OR REPLACE FUNCTION public.desk_bank_list(p_actor uuid, p_account uuid)
RETURNS TABLE (bank_code text, bank_name text, short_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_bank_list', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  RETURN QUERY
  SELECT b.code, b.name, x.short_code
    FROM public.case_banks b
    LEFT JOIN public.desk_bank_codes x ON x.account_id = b.account_id AND x.bank_code = b.code
   WHERE b.account_id = p_account
   ORDER BY b.name, b.code;
END;
$$;

-- ---------- 5. Open a desk case ----------

-- Finds or creates the company and its open application, then the case at
-- the bank through 130's case_open_lead for p_contact, in p_agent's name
-- (p_coordinator named when given). Internal: called by the intake
-- functions only, which have already checked the sorter's scope.
CREATE OR REPLACE FUNCTION public.desk_case_open(p_account uuid, p_trade_licence text, p_legal_name text,
  p_bank_code text, p_product text, p_contact uuid, p_agent uuid, p_coordinator uuid, p_now timestamptz)
RETURNS TABLE (case_id uuid, created boolean, customer_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_lic   text := public.desk_normalise_licence(p_trade_licence);
  v_prod  text := public.desk_clean(p_product);
  v_short text;
  v_cust  uuid;
  v_app   public.desk_applications%ROWTYPE;
  v_seq   integer;
  v_yy    integer;
  v_slot  integer;
  v_part  text;
  v_case  uuid;
  e       public.cases%ROWTYPE;
BEGIN
  IF v_lic !~ '^[A-Z0-9/.]{1,64}$' THEN
    PERFORM public.desk_refuse('desk_case_open', 'INVALID', 'trade licence number required');
  END IF;
  IF v_prod IS NULL OR char_length(v_prod) > 200 THEN
    PERFORM public.desk_refuse('desk_case_open', 'INVALID', 'product required');
  END IF;
  IF p_contact IS NULL THEN
    PERFORM public.desk_refuse('desk_case_open', 'NO_CONTACT', 'a desk case needs a customer contact');
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.desk_refuse('desk_case_open', 'BANK_UNKNOWN', 'not a bank of this workspace');
  END IF;
  SELECT x.short_code INTO v_short FROM public.desk_bank_codes x
   WHERE x.account_id = p_account AND x.bank_code = p_bank_code;
  IF v_short IS NULL THEN
    PERFORM public.desk_refuse('desk_case_open', 'BANK_CODE_MISSING', 'the bank has no desk code');
  END IF;

  -- The company: one live row per (account, licence); a concurrent insert
  -- waits on the unique index and is re-read.
  SELECT c.id INTO v_cust FROM public.desk_customers c
   WHERE c.account_id = p_account AND c.trade_licence_no = v_lic AND c.merged_into IS NULL;
  IF v_cust IS NULL THEN
    IF public.desk_clean(p_legal_name) IS NULL OR char_length(public.desk_clean(p_legal_name)) > 200 THEN
      PERFORM public.desk_refuse('desk_case_open', 'INVALID', 'legal name required for a new company');
    END IF;
    INSERT INTO public.desk_customers AS c (account_id, trade_licence_no, legal_name, created_by)
    VALUES (p_account, v_lic, public.desk_clean(p_legal_name), p_agent)
    ON CONFLICT (account_id, trade_licence_no) WHERE merged_into IS NULL DO NOTHING
    RETURNING c.id INTO v_cust;
    IF v_cust IS NULL THEN
      SELECT c.id INTO v_cust FROM public.desk_customers c
       WHERE c.account_id = p_account AND c.trade_licence_no = v_lic AND c.merged_into IS NULL;
    END IF;
  END IF;

  -- The application: the open one, else a new number under the account's
  -- counter row lock (gapless; a refused open rolls the counter back).
  INSERT INTO public.desk_number_seq (account_id) VALUES (p_account) ON CONFLICT DO NOTHING;
  SELECT q.next_val INTO v_seq FROM public.desk_number_seq q WHERE q.account_id = p_account FOR UPDATE;
  SELECT * INTO v_app FROM public.desk_applications a WHERE a.customer_id = v_cust AND a.status = 'open';
  IF v_app.id IS NULL THEN
    IF v_seq > 9999999 THEN
      PERFORM public.desk_refuse('desk_case_open', 'SEQ_EXHAUSTED', 'application numbers exhausted for the workspace');
    END IF;
    v_yy := extract(year FROM p_now AT TIME ZONE 'Asia/Dubai')::integer % 100;
    UPDATE public.desk_number_seq q SET next_val = q.next_val + 1 WHERE q.account_id = p_account;
    INSERT INTO public.desk_applications AS a (account_id, customer_id, yy, seq, app_number, owner_user_id, created_at)
    VALUES (p_account, v_cust, v_yy, v_seq,
            'TC-' || lpad(v_yy::text, 2, '0') || '-' || public.desk_pad_seq(v_seq), p_agent, p_now)
    RETURNING * INTO v_app;
  END IF;

  -- 130's lock of the (account, contact, bank) triple, so the lead read
  -- below and case_open_lead's own check see the same rows.
  PERFORM public.case_lead_lock(p_account, p_contact, p_bank_code);
  SELECT * INTO e FROM public.cases x
   WHERE x.account_id = p_account AND x.contact_id = p_contact AND x.bank_code = p_bank_code
     AND x.group_id IS NULL AND x.closed_at IS NULL;
  IF FOUND THEN
    -- The contact's open lead at this bank is this application's case for
    -- this product, or a conflict (a lead outside the desk, or another
    -- company / product: one open lead per contact and bank, 130).
    IF e.desk_application_id IS DISTINCT FROM v_app.id OR lower(e.product) IS DISTINCT FROM lower(v_prod) THEN
      PERFORM public.desk_refuse('desk_case_open', 'CASE_CONFLICT',
        'the contact already has an open lead at this bank outside this application or product');
    END IF;
    RETURN QUERY SELECT e.id, false, v_cust;
    RETURN;
  END IF;

  SELECT count(*)::integer + 1 INTO v_slot FROM public.cases x
   WHERE x.desk_application_id = v_app.id AND x.bank_code = p_bank_code;
  IF v_slot > 9 THEN
    PERFORM public.desk_refuse('desk_case_open', 'SUFFIX_EXHAUSTED', 'nine cases at this bank in one application');
  END IF;
  v_part := v_short || CASE WHEN v_slot = 1 THEN '' ELSE v_slot::text END;

  v_case := public.case_open_lead(p_agent, p_account, p_contact, p_bank_code, v_prod, p_agent, NULL,
                                  p_coordinator, 'desk');
  UPDATE public.cases x
     SET desk_application_id = v_app.id, desk_customer_id = v_cust,
         case_number = public.desk_case_number(v_app.yy, v_app.seq, v_part)
   WHERE x.id = v_case;
  RETURN QUERY SELECT v_case, true, v_cust;
END;
$$;

-- ---------- 6. Resolve a case reference ----------

-- Caption code -> the open case it names, or NULL (bad check character,
-- no match). seq is unique per account, so seq + bank part names at most
-- one open case.
CREATE OR REPLACE FUNCTION public.desk_case_resolve_code(p_account uuid, p_code text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v   text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:]]', '', 'g'));
  m   text[] := regexp_match(v, '^([1-9][0-9]{0,6})([A-Z]{3}[2-9]?)([0-9A-Z])$');
  ids uuid[];
BEGIN
  IF m IS NULL OR p_account IS NULL THEN
    RETURN NULL;
  END IF;
  IF public.desk_caption_code(m[1]::integer, m[2]) <> v THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(c.id) INTO ids
    FROM public.cases c
    JOIN public.desk_applications a ON a.id = c.desk_application_id
   WHERE c.account_id = p_account AND a.account_id = p_account AND a.seq = m[1]::integer
     AND split_part(c.case_number, '-', 4) = m[2] AND c.closed_at IS NULL;
  IF cardinality(ids) = 1 THEN
    RETURN ids[1];
  END IF;
  RETURN NULL;
END;
$$;

-- An open case of the account by exact case number or caption code.
CREATE OR REPLACE FUNCTION public.intake_case_by_ref(p_account uuid, p_ref text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v uuid;
BEGIN
  IF public.desk_blank(p_ref) THEN
    RETURN NULL;
  END IF;
  SELECT c.id INTO v FROM public.cases c
   WHERE c.account_id = p_account AND c.case_number = upper(public.desk_clean(p_ref)) AND c.closed_at IS NULL;
  RETURN coalesce(v, public.desk_case_resolve_code(p_account, p_ref));
END;
$$;

-- The sorting screen's confirmation: an open case by number or caption
-- code, with its company, for a sorter in scope of its bank; no row
-- otherwise (out of scope and unknown look the same).
CREATE OR REPLACE FUNCTION public.intake_case_lookup(p_actor uuid, p_account uuid, p_ref text)
RETURNS TABLE (case_id uuid, case_number text, bank_code text, company_name text, contact_id uuid,
  product text, stage text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v uuid;
BEGIN
  IF NOT public.intake_is_sorter(p_actor, p_account) THEN
    PERFORM public.desk_refuse('intake_case_lookup', 'NOT_ALLOWED', 'not a sorter of this workspace');
  END IF;
  v := public.intake_case_by_ref(p_account, p_ref);
  RETURN QUERY
  SELECT c.id, c.case_number, c.bank_code, cu.legal_name, c.contact_id, c.product, c.stage
    FROM public.cases c
    LEFT JOIN public.desk_customers cu ON cu.id = c.desk_customer_id
   WHERE c.id = v AND public.intake_scope_ok(p_actor, p_account, c.bank_code)
     -- and a case they may read (122/161): a team leader sorts every
     -- queue but reads only their team's cases.
     AND public.case_can_read(c.id, p_actor);
END;
$$;

-- ---------- 7. Intake internals ----------

-- The only writer of an item's state: updates the row, appends one event.
CREATE OR REPLACE FUNCTION public.intake_set_state(p_item uuid, p_actor uuid, p_state text, p_case uuid,
  p_kind text, p_doc_key text, p_file uuid, p_dup uuid, p_queue_bank text, p_queue_reason text,
  p_reject text, p_now timestamptz, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.intake_items i
     SET state = p_state, filed_case_id = p_case, filed_kind = p_kind, filed_doc_key = p_doc_key,
         file_id = p_file, duplicate_of_item = p_dup, queue_bank_code = p_queue_bank,
         queue_reason = p_queue_reason, reject_reason = p_reject,
         decided_by = CASE WHEN p_state = 'untagged' THEN NULL ELSE p_actor END,
         decided_at = CASE WHEN p_state = 'untagged' THEN NULL ELSE p_now END
   WHERE i.id = p_item;
  INSERT INTO public.intake_item_events (item_id, at, actor_id, state, case_id, detail)
  VALUES (p_item, p_now, p_actor, p_state, p_case,
          coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
            'queue_bank_code', p_queue_bank, 'queue_reason', p_queue_reason, 'file_id', p_file,
            'duplicate_of_item', p_dup, 'reject_reason', p_reject, 'doc_key', p_doc_key)));
END;
$$;

-- Files the item onto the case: 'duplicate' when the same bytes were
-- already filed there, else (with a file) the uploader's staff_upload
-- document (180) registered on the case.
CREATE OR REPLACE FUNCTION public.intake_apply(p_item uuid, p_actor uuid, p_case uuid, p_kind text,
  p_doc_key text, p_now timestamptz, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i        public.intake_items%ROWTYPE;
  c        public.cases%ROWTYPE;
  v_dup    uuid;
  v_doc    uuid;
  v_file   uuid;
BEGIN
  SELECT * INTO i FROM public.intake_items x WHERE x.id = p_item;
  -- 181's lock order: the case first.
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND OR c.account_id <> i.account_id THEN
    PERFORM public.desk_refuse('intake_apply', 'CASE_NOT_FOUND', 'case not found');
  END IF;
  IF c.closed_at IS NOT NULL THEN
    PERFORM public.desk_refuse('intake_apply', 'CASE_CLOSED', 'case is closed');
  END IF;
  IF i.sha256 IS NOT NULL THEN
    IF c.contact_id IS NULL THEN
      PERFORM public.desk_refuse('intake_apply', 'NO_CONTACT', 'the case has no customer contact to file under');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('intake:' || p_case::text || ':' || i.sha256, 0));
    SELECT x.id INTO v_dup FROM public.intake_items x
     WHERE x.filed_case_id = p_case AND x.sha256 = i.sha256 AND x.state = 'filed' AND x.id <> p_item
     ORDER BY x.decided_at, x.id LIMIT 1;
    IF v_dup IS NOT NULL THEN
      PERFORM public.intake_set_state(p_item, p_actor, 'duplicate', p_case, p_kind, p_doc_key, NULL, v_dup,
        NULL, NULL, NULL, p_now, p_detail);
      RETURN;
    END IF;
    SELECT r.document_id INTO v_doc
      FROM public.customer_documents_record_internal(i.account_id, c.contact_id, 'staff_upload',
             CASE WHEN i.mime = 'application/pdf' THEN 'document' ELSE 'image' END,
             'case-files', i.storage_path, i.received_at, i.mime, i.original_name, p_case, i.uploaded_by) r;
    IF v_doc IS NULL THEN
      PERFORM public.desk_refuse('intake_apply', 'FILE_INVALID', 'the file could not be recorded');
    END IF;
    INSERT INTO public.case_document_files (account_id, case_id, customer_document_id, registered_by)
    VALUES (i.account_id, p_case, v_doc, i.uploaded_by)
    ON CONFLICT ON CONSTRAINT case_document_files_one_per_document DO NOTHING
    RETURNING id INTO v_file;
    IF v_file IS NULL THEN
      SELECT x.id INTO v_file FROM public.case_document_files x
       WHERE x.case_id = p_case AND x.customer_document_id = v_doc;
    END IF;
  END IF;
  PERFORM public.intake_set_state(p_item, p_actor, 'filed', p_case, p_kind, p_doc_key, v_file, NULL,
    NULL, NULL, NULL, p_now, p_detail);
END;
$$;

-- Routes an item on its stored tags (the item row is locked by the caller).
CREATE OR REPLACE FUNCTION public.intake_route(p_item uuid, p_actor uuid, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i        public.intake_items%ROWTYPE;
  c        public.cases%ROWTYPE;
  v_bank   text;
  v_case   uuid;
  v_cust   uuid;
  v_created boolean;
  v_state  text;
  v_hint   text;
  v_reason text;
BEGIN
  SELECT * INTO i FROM public.intake_items x WHERE x.id = p_item;
  v_bank := i.bank_code;
  IF i.kind IS NULL THEN
    v_reason := 'NO_KIND';
  ELSIF i.kind = 'new_case' THEN
    IF v_bank IS NULL OR i.trade_licence_no IS NULL OR i.company_name IS NULL OR i.product IS NULL THEN
      v_reason := 'NO_CASE';
    ELSIF i.contact_id IS NULL THEN
      v_reason := 'NO_CONTACT';
    -- A licence on file under another legal name never opens or joins a
    -- case automatically.
    ELSIF EXISTS (SELECT 1 FROM public.desk_customers cu
                   WHERE cu.account_id = i.account_id AND cu.merged_into IS NULL
                     AND cu.trade_licence_no = public.desk_normalise_licence(i.trade_licence_no)
                     AND public.desk_normalise_name(cu.legal_name) <> public.desk_normalise_name(i.company_name)) THEN
      v_reason := 'CASE_EXISTS_NAME_MISMATCH';
    ELSE
      BEGIN
        SELECT o.case_id, o.created, o.customer_id INTO v_case, v_created, v_cust
          FROM public.desk_case_open(i.account_id, i.trade_licence_no, i.company_name, v_bank, i.product,
                                     i.contact_id, i.uploaded_by, NULL, p_now) o;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
        IF v_state LIKE '40%' OR v_state LIKE '55%' OR v_state LIKE '57%' THEN
          RAISE;
        END IF;
        v_case := NULL;
        v_reason := coalesce(nullif(v_hint, ''), 'CASE_OPEN_FAILED');
      END;
      IF v_case IS NOT NULL THEN
        PERFORM public.intake_apply(p_item, p_actor, v_case, 'new_case', i.doc_key, p_now);
        RETURN;
      END IF;
    END IF;
  ELSE
    IF i.case_ref IS NULL THEN
      v_reason := 'NO_CASE';
    ELSE
      v_case := public.intake_case_by_ref(i.account_id, i.case_ref);
      IF v_case IS NULL THEN
        v_reason := 'CASE_NOT_FOUND';
      ELSE
        SELECT * INTO c FROM public.cases x WHERE x.id = v_case;
        IF i.bank_code IS NOT NULL AND i.bank_code IS DISTINCT FROM c.bank_code THEN
          v_reason := 'BANK_MISMATCH';
        ELSIF i.kind = 'pending_doc' AND i.sha256 IS NULL THEN
          v_reason := 'NO_FILE';
          v_bank := coalesce(v_bank, c.bank_code);
        ELSE
          BEGIN
            PERFORM public.intake_apply(p_item, p_actor, v_case, i.kind, i.doc_key, p_now);
            RETURN;
          EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
            IF v_state LIKE '40%' OR v_state LIKE '55%' OR v_state LIKE '57%' THEN
              RAISE;
            END IF;
            v_reason := coalesce(nullif(v_hint, ''), 'FILE_FAILED');
            v_bank := coalesce(v_bank, c.bank_code);
          END;
        END IF;
      END IF;
    END IF;
  END IF;
  PERFORM public.intake_set_state(p_item, p_actor, 'untagged', NULL, NULL, NULL, NULL, NULL, v_bank, v_reason,
    NULL, p_now, jsonb_build_object('routed', true));
END;
$$;

CREATE OR REPLACE FUNCTION public.intake_result(p_item uuid, p_replayed boolean)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.id, i.state, i.filed_case_id, c.case_number,
         CASE WHEN a.id IS NOT NULL THEN public.desk_caption_code(a.seq, split_part(c.case_number, '-', 4)) END,
         i.file_id, i.duplicate_of_item, i.queue_bank_code, i.queue_reason, p_replayed
    FROM public.intake_items i
    LEFT JOIN public.cases c ON c.id = i.filed_case_id
    LEFT JOIN public.desk_applications a ON a.id = c.desk_application_id
   WHERE i.id = p_item
$$;

-- Tags shared by submit and retag; NULL-in means "not given".
CREATE OR REPLACE FUNCTION public.intake_check_tags(p_fn text, p_account uuid, p_kind text, p_bank_code text,
  p_contact uuid, p_doc_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_kind IS NOT NULL AND p_kind NOT IN ('new_case', 'pending_doc', 'info') THEN
    PERFORM public.desk_refuse(p_fn, 'INVALID', 'kind: new_case, pending_doc or info');
  END IF;
  IF p_doc_key IS NOT NULL AND p_doc_key !~ '^[a-z0-9_]{1,64}$' THEN
    PERFORM public.desk_refuse(p_fn, 'INVALID', 'doc_key invalid');
  END IF;
  IF p_bank_code IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code) THEN
    PERFORM public.desk_refuse(p_fn, 'BANK_UNKNOWN', 'not a bank of this workspace');
  END IF;
  IF p_contact IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = p_contact AND ct.account_id = p_account) THEN
    PERFORM public.desk_refuse(p_fn, 'INVALID', 'contact not found');
  END IF;
END;
$$;

-- ---------- 8. Submit ----------

-- p_item is minted by the app, which stored the file (if any) at
-- 'intake/<p_item>/<sha256>.<ext>' first. The same (uploader, idem_key)
-- again returns the first result with replayed = true.
CREATE OR REPLACE FUNCTION public.intake_submit(p_actor uuid, p_account uuid, p_item uuid, p_idem_key text,
  p_kind text, p_bank_code text, p_case_ref text, p_company_name text, p_trade_licence text, p_product text,
  p_contact uuid, p_doc_key text, p_note text, p_storage_path text, p_original_name text, p_mime text,
  p_size bigint, p_sha256 text, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_id  uuid;
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('intake_submit', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  IF p_idem_key IS NULL OR char_length(p_idem_key) NOT BETWEEN 8 AND 80 OR p_idem_key !~ '^[A-Za-z0-9_:.-]+$' THEN
    PERFORM public.desk_refuse('intake_submit', 'INVALID', 'idem_key: 8-80 of A-Z a-z 0-9 _ : . -');
  END IF;
  SELECT x.id INTO v_id FROM public.intake_items x
   WHERE x.account_id = p_account AND x.uploaded_by = p_actor AND x.idem_key = p_idem_key;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM public.intake_result(v_id, true);
    RETURN;
  END IF;
  IF p_item IS NULL THEN
    PERFORM public.desk_refuse('intake_submit', 'INVALID', 'item id required');
  END IF;
  PERFORM public.intake_check_tags('intake_submit', p_account, p_kind, public.desk_clean(p_bank_code), p_contact, p_doc_key);
  BEGIN
    INSERT INTO public.intake_items AS x (id, account_id, uploaded_by, idem_key, channel, received_at, kind,
      bank_code, case_ref, company_name, trade_licence_no, product, contact_id, doc_key, note,
      storage_path, original_name, mime, size_bytes, sha256)
    VALUES (p_item, p_account, p_actor, p_idem_key, 'wacrm', v_now, p_kind,
      public.desk_clean(p_bank_code), public.desk_clean(p_case_ref), public.desk_clean(p_company_name),
      public.desk_clean(p_trade_licence), public.desk_clean(p_product), p_contact, p_doc_key,
      public.desk_clean(p_note), p_storage_path, public.desk_clean(p_original_name), p_mime, p_size, p_sha256);
  EXCEPTION
    WHEN unique_violation THEN
      -- A concurrent call with the same key won and committed.
      SELECT x.id INTO v_id FROM public.intake_items x
       WHERE x.account_id = p_account AND x.uploaded_by = p_actor AND x.idem_key = p_idem_key;
      IF v_id IS NULL THEN
        PERFORM public.desk_refuse('intake_submit', 'INVALID', 'item id already used');
      END IF;
      RETURN QUERY SELECT * FROM public.intake_result(v_id, true);
      RETURN;
    WHEN check_violation THEN
      PERFORM public.desk_refuse('intake_submit', 'FILE_INVALID', 'file or tag fields are invalid');
  END;
  INSERT INTO public.intake_item_events (item_id, at, actor_id, state, detail)
  VALUES (p_item, v_now, p_actor, 'untagged', jsonb_build_object('received', 'wacrm'));
  PERFORM 1 FROM public.intake_items x WHERE x.id = p_item FOR UPDATE;
  PERFORM public.intake_route(p_item, p_actor, v_now);
  RETURN QUERY SELECT * FROM public.intake_result(p_item, false);
END;
$$;

-- ---------- 9. Sorting ----------

CREATE OR REPLACE FUNCTION public.intake_queue_list(p_actor uuid, p_account uuid, p_bank_code text DEFAULT NULL)
RETURNS TABLE (item_id uuid, uploaded_by uuid, received_at timestamptz, age_seconds bigint, kind text,
  bank_code text, case_ref text, company_name text, trade_licence_no text, product text, contact_id uuid,
  doc_key text, note text, original_name text, mime text, size_bytes bigint, has_file boolean,
  queue_bank_code text, queue_reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.intake_is_sorter(p_actor, p_account) THEN
    PERFORM public.desk_refuse('intake_queue_list', 'NOT_ALLOWED', 'not a sorter of this workspace');
  END IF;
  RETURN QUERY
  SELECT i.id, i.uploaded_by, i.received_at, floor(extract(epoch FROM now() - i.received_at))::bigint,
         i.kind, i.bank_code, i.case_ref, i.company_name, i.trade_licence_no, i.product, i.contact_id,
         i.doc_key, i.note, i.original_name, i.mime, i.size_bytes, i.sha256 IS NOT NULL,
         i.queue_bank_code, i.queue_reason
    FROM public.intake_items i
   WHERE i.account_id = p_account AND i.state = 'untagged'
     AND (p_bank_code IS NULL OR i.queue_bank_code = p_bank_code)
     AND public.intake_scope_ok(p_actor, p_account, i.queue_bank_code)
   ORDER BY i.received_at, i.id
   LIMIT 500;
END;
$$;

-- The item locked for a sorting decision. An actor outside the item's
-- account learns nothing about it.
CREATE OR REPLACE FUNCTION public.intake_lock_for_sort(p_fn text, p_actor uuid, p_account uuid, p_item uuid)
RETURNS public.intake_items
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.intake_items%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.intake_items x WHERE x.id = p_item FOR UPDATE;
  IF NOT FOUND OR i.account_id IS DISTINCT FROM p_account OR public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse(p_fn, 'ITEM_NOT_FOUND', 'item not found');
  END IF;
  IF NOT public.intake_is_sorter(p_actor, p_account) THEN
    PERFORM public.desk_refuse(p_fn, 'NOT_ALLOWED', 'not a sorter of this workspace');
  END IF;
  IF i.state <> 'untagged' THEN
    PERFORM public.desk_refuse(p_fn, 'ITEM_NOT_OPEN', format('item is %s', i.state));
  END IF;
  IF NOT public.intake_scope_ok(p_actor, p_account, i.queue_bank_code) THEN
    PERFORM public.desk_refuse(p_fn, 'BANK_SCOPE', 'not in scope for the item''s queue');
  END IF;
  RETURN i;
END;
$$;

CREATE OR REPLACE FUNCTION public.intake_file(p_actor uuid, p_account uuid, p_item uuid, p_case uuid,
  p_kind text, p_doc_key text, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  i     public.intake_items%ROWTYPE := public.intake_lock_for_sort('intake_file', p_actor, p_account, p_item);
  c     public.cases%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('pending_doc', 'info') THEN
    PERFORM public.desk_refuse('intake_file', 'INVALID', 'kind: pending_doc or info (a new case: intake_file_new_case)');
  END IF;
  IF p_doc_key IS NOT NULL AND p_doc_key !~ '^[a-z0-9_]{1,64}$' THEN
    PERFORM public.desk_refuse('intake_file', 'INVALID', 'doc_key invalid');
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT FOUND OR c.account_id <> p_account THEN
    PERFORM public.desk_refuse('intake_file', 'CASE_NOT_FOUND', 'case not found');
  END IF;
  IF c.closed_at IS NOT NULL THEN
    PERFORM public.desk_refuse('intake_file', 'CASE_CLOSED', 'case is closed');
  END IF;
  IF NOT public.intake_scope_ok(p_actor, p_account, c.bank_code) THEN
    PERFORM public.desk_refuse('intake_file', 'BANK_SCOPE', 'not a sorter of the case''s bank');
  END IF;
  -- Filing writes the case: the sorter must be able to (a bank holder is
  -- its coordinator by 161; a team leader only on their team's cases).
  IF NOT public.case_can_write(p_case, p_actor) THEN
    PERFORM public.desk_refuse('intake_file', 'CASE_NOT_FOUND', 'case not found');
  END IF;
  IF p_kind = 'pending_doc' AND i.sha256 IS NULL THEN
    PERFORM public.desk_refuse('intake_file', 'NO_FILE', 'a pending document needs a file');
  END IF;
  PERFORM public.intake_apply(p_item, p_actor, p_case, p_kind, coalesce(p_doc_key, i.doc_key), v_now,
    jsonb_build_object('sorted', true));
  RETURN QUERY SELECT * FROM public.intake_result(p_item, false);
END;
$$;

-- Opens (or joins) the company's case at the bank in the UPLOADER's name;
-- a sorter who holds the bank is named its coordinator.
CREATE OR REPLACE FUNCTION public.intake_file_new_case(p_actor uuid, p_account uuid, p_item uuid,
  p_trade_licence text, p_legal_name text, p_bank_code text, p_product text, p_contact uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now  timestamptz := coalesce(p_now, now());
  i      public.intake_items%ROWTYPE := public.intake_lock_for_sort('intake_file_new_case', p_actor, p_account, p_item);
  v_case uuid;
  v_cust uuid;
  v_new  boolean;
BEGIN
  IF NOT public.intake_scope_ok(p_actor, p_account, p_bank_code) THEN
    PERFORM public.desk_refuse('intake_file_new_case', 'BANK_SCOPE', 'not a sorter of that bank');
  END IF;
  IF p_contact IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = p_contact AND ct.account_id = p_account) THEN
    PERFORM public.desk_refuse('intake_file_new_case', 'INVALID', 'contact not found');
  END IF;
  SELECT o.case_id, o.customer_id, o.created INTO v_case, v_cust, v_new
    FROM public.desk_case_open(p_account, p_trade_licence, p_legal_name, p_bank_code, p_product,
           p_contact, i.uploaded_by,
           CASE WHEN public.case_holds_bank(p_account, p_actor, p_bank_code) THEN p_actor END, v_now) o;
  -- A company already on file is joined only under its own legal name.
  IF NOT v_new AND (SELECT public.desk_normalise_name(cu.legal_name) FROM public.desk_customers cu WHERE cu.id = v_cust)
                   IS DISTINCT FROM public.desk_normalise_name(p_legal_name) THEN
    PERFORM public.desk_refuse('intake_file_new_case', 'CASE_CONFLICT', 'the licence is on file under another legal name');
  END IF;
  PERFORM public.intake_apply(p_item, p_actor, v_case, 'new_case', i.doc_key, v_now,
    jsonb_build_object('sorted', true, 'case_opened_as', i.uploaded_by));
  RETURN QUERY SELECT * FROM public.intake_result(p_item, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.intake_reject(p_actor uuid, p_account uuid, p_item uuid, p_reason text,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  i public.intake_items%ROWTYPE := public.intake_lock_for_sort('intake_reject', p_actor, p_account, p_item);
BEGIN
  IF public.desk_clean(p_reason) IS NULL THEN
    PERFORM public.desk_refuse('intake_reject', 'REASON_REQUIRED', 'a reason is required');
  END IF;
  IF char_length(public.desk_clean(p_reason)) > 500 THEN
    PERFORM public.desk_refuse('intake_reject', 'INVALID', 'reason over 500 characters');
  END IF;
  PERFORM public.intake_set_state(p_item, p_actor, 'rejected', NULL, NULL, NULL, NULL, NULL,
    i.queue_bank_code, i.queue_reason, public.desk_clean(p_reason), coalesce(p_now, now()));
  RETURN QUERY SELECT * FROM public.intake_result(p_item, false);
END;
$$;

-- The uploader's correction of their own untagged item; routed again.
CREATE OR REPLACE FUNCTION public.intake_retag(p_actor uuid, p_account uuid, p_item uuid, p_kind text,
  p_bank_code text, p_case_ref text, p_company_name text, p_trade_licence text, p_product text,
  p_contact uuid, p_doc_key text, p_note text, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  i     public.intake_items%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.intake_items x WHERE x.id = p_item FOR UPDATE;
  IF NOT FOUND OR i.account_id IS DISTINCT FROM p_account OR public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('intake_retag', 'ITEM_NOT_FOUND', 'item not found');
  END IF;
  IF i.uploaded_by IS DISTINCT FROM p_actor THEN
    PERFORM public.desk_refuse('intake_retag', 'NOT_ALLOWED', 'only the uploader retags');
  END IF;
  IF i.state <> 'untagged' THEN
    PERFORM public.desk_refuse('intake_retag', 'ITEM_NOT_OPEN', format('item is %s', i.state));
  END IF;
  PERFORM public.intake_check_tags('intake_retag', p_account, p_kind, public.desk_clean(p_bank_code), p_contact, p_doc_key);
  BEGIN
    UPDATE public.intake_items x
       SET kind = p_kind, bank_code = public.desk_clean(p_bank_code), case_ref = public.desk_clean(p_case_ref),
           company_name = public.desk_clean(p_company_name), trade_licence_no = public.desk_clean(p_trade_licence),
           product = public.desk_clean(p_product), contact_id = p_contact, doc_key = p_doc_key,
           note = public.desk_clean(p_note)
     WHERE x.id = p_item;
  EXCEPTION WHEN check_violation THEN
    PERFORM public.desk_refuse('intake_retag', 'INVALID', 'tag fields are invalid');
  END;
  INSERT INTO public.intake_item_events (item_id, at, actor_id, state, detail)
  VALUES (p_item, v_now, p_actor, 'untagged', jsonb_build_object('retag', true, 'previous_tags', jsonb_build_object(
    'kind', i.kind, 'bank_code', i.bank_code, 'case_ref', i.case_ref, 'company_name', i.company_name,
    'trade_licence_no', i.trade_licence_no, 'product', i.product, 'contact_id', i.contact_id,
    'doc_key', i.doc_key, 'note', i.note)));
  PERFORM public.intake_route(p_item, p_actor, v_now);
  RETURN QUERY SELECT * FROM public.intake_result(p_item, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.intake_my_list(p_actor uuid, p_account uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (item_id uuid, received_at timestamptz, kind text, state text, case_id uuid, case_number text,
  bank_code text, case_ref text, company_name text, trade_licence_no text, product text, contact_id uuid,
  doc_key text, note text, original_name text, file_id uuid, queue_bank_code text, queue_reason text,
  reject_reason text, duplicate_of_item uuid, duplicate_of_uploader uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('intake_my_list', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  RETURN QUERY
  SELECT i.id, i.received_at, i.kind, i.state, i.filed_case_id, c.case_number,
         i.bank_code, i.case_ref, i.company_name, i.trade_licence_no, i.product, i.contact_id,
         coalesce(i.filed_doc_key, i.doc_key), i.note, i.original_name, i.file_id, i.queue_bank_code,
         i.queue_reason, i.reject_reason, i.duplicate_of_item, d.uploaded_by
    FROM public.intake_items i
    LEFT JOIN public.cases c ON c.id = i.filed_case_id
    LEFT JOIN public.intake_items d ON d.id = i.duplicate_of_item
   WHERE i.account_id = p_account AND i.uploaded_by = p_actor
   ORDER BY i.received_at DESC, i.id
   LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
END;
$$;

-- One row per bank with holders or untagged items, plus the no-bank row
-- (bank_code NULL). alert: no_coordinator (a bank nobody holds) > lead
-- (oldest untagged over 4 h) > second (over 2 h) > none. ASSUMPTION: the
-- two thresholds are the package's, for the owner to confirm.
CREATE OR REPLACE FUNCTION public.intake_desk_overview(p_actor uuid, p_account uuid, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (bank_code text, bank_name text, short_code text, holders integer, to_sort integer,
  oldest_age_seconds bigint, alert text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  c_second constant integer := 2 * 3600;
  c_lead   constant integer := 4 * 3600;
  v_now    timestamptz := coalesce(p_now, now());
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('team_lead', 'admin', 'super_admin') THEN
    PERFORM public.desk_refuse('intake_desk_overview', 'NOT_ALLOWED', 'team leaders and up only');
  END IF;
  RETURN QUERY
  WITH q AS (
    SELECT i.queue_bank_code AS bank, count(*)::integer AS n, min(i.received_at) AS oldest
      FROM public.intake_items i
     WHERE i.account_id = p_account AND i.state = 'untagged'
     GROUP BY i.queue_bank_code
  ), h AS (
    SELECT b.bank_code AS bank, count(*)::integer AS n
      FROM public.coordinator_banks b
     WHERE b.account_id = p_account AND public.case_holds_bank(p_account, b.user_id, b.bank_code)
     GROUP BY b.bank_code
  ), banks AS (
    SELECT cb.code, cb.name FROM public.case_banks cb
     WHERE cb.account_id = p_account
       AND (EXISTS (SELECT 1 FROM h WHERE h.bank = cb.code) OR EXISTS (SELECT 1 FROM q WHERE q.bank = cb.code))
  ), rows AS (
    SELECT b.code AS bank, b.name, coalesce(h.n, 0) AS holders, coalesce(q.n, 0) AS n, q.oldest
      FROM banks b LEFT JOIN h ON h.bank = b.code LEFT JOIN q ON q.bank = b.code
    UNION ALL
    SELECT NULL, NULL, 0, coalesce((SELECT q.n FROM q WHERE q.bank IS NULL), 0),
           (SELECT q.oldest FROM q WHERE q.bank IS NULL)
  )
  SELECT r.bank, r.name, x.short_code, r.holders, r.n,
         CASE WHEN r.oldest IS NULL THEN NULL ELSE floor(extract(epoch FROM v_now - r.oldest))::bigint END,
         CASE
           WHEN r.bank IS NOT NULL AND r.holders = 0 THEN 'no_coordinator'
           WHEN r.oldest IS NOT NULL AND v_now - r.oldest > make_interval(secs => c_lead) THEN 'lead'
           WHEN r.oldest IS NOT NULL AND v_now - r.oldest > make_interval(secs => c_second) THEN 'second'
           ELSE 'none'
         END
    FROM rows r
    LEFT JOIN public.desk_bank_codes x ON x.account_id = p_account AND x.bank_code = r.bank
   ORDER BY r.bank NULLS LAST;
END;
$$;

-- ---------- 10. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_check_char(text), public.desk_pad_seq(integer), public.desk_case_number(integer, integer, text),
  public.desk_caption_code(integer, text), public.desk_normalise_licence(text), public.desk_normalise_name(text),
  public.desk_blank(text), public.desk_clean(text), public.desk_refuse(text, text, text),
  public.intake_scope_ok(uuid, uuid, text), public.intake_is_sorter(uuid, uuid),
  public.desk_bank_code_set(uuid, uuid, text, text), public.desk_bank_by_short(uuid, text),
  public.desk_bank_list(uuid, uuid),
  public.desk_case_open(uuid, text, text, text, text, uuid, uuid, uuid, timestamptz),
  public.desk_case_resolve_code(uuid, text), public.intake_case_by_ref(uuid, text),
  public.intake_case_lookup(uuid, uuid, text),
  public.intake_set_state(uuid, uuid, text, uuid, text, text, uuid, uuid, text, text, text, timestamptz, jsonb),
  public.intake_apply(uuid, uuid, uuid, text, text, timestamptz, jsonb),
  public.intake_route(uuid, uuid, timestamptz), public.intake_result(uuid, boolean),
  public.intake_check_tags(text, uuid, text, text, uuid, text),
  public.intake_submit(uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, text, text, text, text,
                       text, bigint, text, timestamptz),
  public.intake_queue_list(uuid, uuid, text), public.intake_lock_for_sort(text, uuid, uuid, uuid),
  public.intake_file(uuid, uuid, uuid, uuid, text, text, timestamptz),
  public.intake_file_new_case(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz),
  public.intake_reject(uuid, uuid, uuid, text, timestamptz),
  public.intake_retag(uuid, uuid, uuid, text, text, text, text, text, text, uuid, text, text, timestamptz),
  public.intake_my_list(uuid, uuid, integer), public.intake_desk_overview(uuid, uuid, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;

-- The pure numbering helpers are safe for anyone (no data); the API
-- surface is the service role's.
GRANT EXECUTE ON FUNCTION
  public.desk_check_char(text), public.desk_pad_seq(integer), public.desk_case_number(integer, integer, text),
  public.desk_caption_code(integer, text)
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_bank_code_set(uuid, uuid, text, text), public.desk_bank_by_short(uuid, text),
  public.desk_bank_list(uuid, uuid), public.intake_case_lookup(uuid, uuid, text),
  public.intake_submit(uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, text, text, text, text,
                       text, bigint, text, timestamptz),
  public.intake_queue_list(uuid, uuid, text),
  public.intake_file(uuid, uuid, uuid, uuid, text, text, timestamptz),
  public.intake_file_new_case(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz),
  public.intake_reject(uuid, uuid, uuid, text, timestamptz),
  public.intake_retag(uuid, uuid, uuid, text, text, text, text, text, text, uuid, text, text, timestamptz),
  public.intake_my_list(uuid, uuid, integer), public.intake_desk_overview(uuid, uuid, timestamptz)
TO service_role;
