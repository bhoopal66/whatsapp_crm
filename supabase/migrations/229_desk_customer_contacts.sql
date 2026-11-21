-- ============================================================
-- 229_desk_customer_contacts.sql — who speaks for a company (design 035
-- D1, slice A), and the privacy registry later desk slices use.
--
--  * desk_customer_contacts links a desk company (220's desk_customers,
--    one per trade licence) to the CRM contacts who act for it, with a
--    role (owner | pro | accountant | other) and an `authorised` flag.
--    Many to many: one PRO's phone may speak for several companies, and a
--    company has several people. A CRM contact is one phone per workspace
--    (022's unique phone_normalized), so the contact IS the phone here.
--  * The link is a fact for people and for routing, never a grant: it
--    opens no case, chat or contact to anyone. WhatsApp routing (a later
--    slice) reads it through desk_customers_for_contact and never files
--    by phone alone.
--  * Every desk case's own contact is linked automatically (role 'other',
--    not authorised) by a trigger on cases, and the existing desk cases
--    are backfilled once. The trigger never fails a case write.
--  * Who: reading a company's contacts needs a readable case of the
--    company, or team leader and up (case_account_role); changing them
--    needs a writable case of the company, or team leader and up. The
--    contact must be one the actor can see (129's memory_can_read, the
--    explicit-user mirror of can_view_contact).
--  * privacy_extensions: 221's export and 222's erase call every function
--    registered here, so a later table joins the PDPL export and erase by
--    registering, without restating those bodies. Only the migration
--    owner writes it (no grants). The link table is exported and kept on
--    erasure (KYC: who acts for a company account); the contact row
--    itself is anonymised by 222 as before.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, CUSTOMER_NOT_FOUND,
-- CONTACT_INVALID.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role, after re-applying 221 and 222 (they gained the
-- registry hook): 229 refuses otherwise, before any change.
-- Re-runnable. Asserted by supabase/ci/verify-desk-customer-contacts.sql.
-- docs/case-desk.md is the contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '229 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'privacy_subject_export'
                    AND p.prosrc LIKE '%privacy_extensions%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'privacy_subject_erase'
                       AND p.prosrc LIKE '%privacy_extensions%') THEN
    RAISE EXCEPTION '229: re-apply 221_privacy_export.sql and 222_privacy_erase.sql first (they now call privacy_extensions)';
  END IF;
END $$;

-- ---------- 1. The privacy registry ----------

CREATE TABLE IF NOT EXISTS public.privacy_extensions (
  name       text PRIMARY KEY,
  export_fn  text NOT NULL,
  erase_fn   text NULL,
  added_in   text NOT NULL,
  CONSTRAINT privacy_extensions_name_check CHECK (name ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT privacy_extensions_export_check CHECK (export_fn ~ '^privacy_[a-z0-9_]{1,60}$'),
  CONSTRAINT privacy_extensions_erase_check CHECK (erase_fn IS NULL OR erase_fn ~ '^privacy_[a-z0-9_]{1,60}$')
);
ALTER TABLE public.privacy_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_extensions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_extensions FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.privacy_extensions IS
  'Export / erase functions of tables added after 222, called by privacy_subject_export and privacy_subject_erase: '
  'export_fn(account, contact) -> jsonb section; erase_fn(account, contact) -> {counts, objects}. Migration 229.';

-- ---------- 2. Company contacts ----------

CREATE TABLE IF NOT EXISTS public.desk_customer_contacts (
  account_id   uuid NOT NULL,
  customer_id  uuid NOT NULL,
  contact_id   uuid NOT NULL,
  role         text NOT NULL DEFAULT 'other',
  authorised   boolean NOT NULL DEFAULT false,
  added_by     uuid NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, contact_id),
  CONSTRAINT desk_customer_contacts_customer_fkey FOREIGN KEY (customer_id, account_id)
    REFERENCES public.desk_customers (id, account_id) ON DELETE CASCADE,
  CONSTRAINT desk_customer_contacts_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT desk_customer_contacts_role_check CHECK (role IN ('owner', 'pro', 'accountant', 'other'))
);
CREATE INDEX IF NOT EXISTS desk_customer_contacts_contact_idx
  ON public.desk_customer_contacts (account_id, contact_id);
ALTER TABLE public.desk_customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_customer_contacts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_customer_contacts FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_customer_contacts IS
  'The CRM contacts who act for a desk company (owner / PRO / accountant / other, authorised or not). '
  'A phone may act for several companies. Never a grant. added_by NULL = linked automatically from a desk case. Migration 229.';

-- ---------- 3. Who ----------

-- May p_actor read the company's contacts? Team leader and up, or anyone
-- who can read one of its cases in this workspace.
CREATE OR REPLACE FUNCTION public.desk_customer_can_read(p_actor uuid, p_account uuid, p_customer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.desk_customers d
                  WHERE d.id = p_customer AND d.account_id = p_account AND d.merged_into IS NULL)
     AND (coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)
          OR EXISTS (SELECT 1 FROM public.cases k
                      WHERE k.desk_customer_id = p_customer AND k.account_id = p_account
                        AND public.case_can_read(k.id, p_actor)))
$$;

-- May p_actor change them? Team leader and up, or a writer of one of its cases.
CREATE OR REPLACE FUNCTION public.desk_customer_can_manage(p_actor uuid, p_account uuid, p_customer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.desk_customers d
                  WHERE d.id = p_customer AND d.account_id = p_account AND d.merged_into IS NULL)
     AND (coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)
          OR EXISTS (SELECT 1 FROM public.cases k
                      WHERE k.desk_customer_id = p_customer AND k.account_id = p_account
                        AND public.case_can_write(k.id, p_actor)))
$$;

-- ---------- 4. Find a company ----------

-- Companies the actor may read whose licence (normalised) or legal name
-- contains p_query (2+ characters), newest first.
CREATE OR REPLACE FUNCTION public.desk_customer_find(p_actor uuid, p_account uuid, p_query text,
  p_limit integer DEFAULT 20)
RETURNS TABLE (customer_id uuid, legal_name text, trade_licence_no text, app_number text,
               contacts integer, can_manage boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_q   text := public.desk_clean(p_query);
  v_lic text;
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_customer_find', 'NOT_ALLOWED', 'staff only');
  END IF;
  IF v_q IS NULL OR char_length(v_q) < 2 OR char_length(v_q) > 200 THEN
    PERFORM public.desk_refuse('desk_customer_find', 'INVALID', 'search with 2 to 200 characters');
  END IF;
  v_lic := public.desk_normalise_licence(v_q);
  RETURN QUERY
  SELECT d.id, d.legal_name, d.trade_licence_no,
         (SELECT a.app_number FROM public.desk_applications a WHERE a.customer_id = d.id AND a.status = 'open'),
         (SELECT count(*)::integer FROM public.desk_customer_contacts l WHERE l.customer_id = d.id),
         public.desk_customer_can_manage(p_actor, p_account, d.id)
    FROM public.desk_customers d
   WHERE d.account_id = p_account AND d.merged_into IS NULL
     AND ((v_lic <> '' AND strpos(d.trade_licence_no, v_lic) > 0)
          OR strpos(lower(d.legal_name), lower(v_q)) > 0)
     AND public.desk_customer_can_read(p_actor, p_account, d.id)
   ORDER BY d.created_at DESC
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
END;
$$;

-- ---------- 5. List, set, remove ----------

CREATE OR REPLACE FUNCTION public.desk_customer_contacts_list(p_actor uuid, p_account uuid, p_customer uuid)
RETURNS TABLE (contact_id uuid, name text, phone text, role text, authorised boolean,
               automatic boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contacts_list', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  RETURN QUERY
  SELECT l.contact_id, c.name, c.phone, l.role, l.authorised, l.added_by IS NULL, l.created_at, l.updated_at
    FROM public.desk_customer_contacts l
    JOIN public.contacts c ON c.id = l.contact_id AND c.account_id = l.account_id
   WHERE l.customer_id = p_customer AND l.account_id = p_account
   ORDER BY l.authorised DESC, l.created_at;
END;
$$;

-- Link (or update) a contact. Returns true when a row was created.
CREATE OR REPLACE FUNCTION public.desk_customer_contact_set(p_actor uuid, p_account uuid, p_customer uuid,
  p_contact uuid, p_role text, p_authorised boolean, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now     timestamptz := coalesce(p_now, now());
  v_created boolean;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_set', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  IF NOT public.desk_customer_can_manage(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_set', 'NOT_ALLOWED', 'you cannot change this company');
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'pro', 'accountant', 'other') OR p_authorised IS NULL THEN
    PERFORM public.desk_refuse('desk_customer_contact_set', 'INVALID', 'role and authorised are required');
  END IF;
  -- A contact of this workspace the actor can see; anything else reads the
  -- same, so the refusal says nothing about another workspace.
  IF p_contact IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account)
     OR NOT public.memory_can_read(p_actor, p_account, 'contact', p_contact) THEN
    PERFORM public.desk_refuse('desk_customer_contact_set', 'CONTACT_INVALID', 'not a contact you can see');
  END IF;

  INSERT INTO public.desk_customer_contacts AS l
    (account_id, customer_id, contact_id, role, authorised, added_by, created_at, updated_by, updated_at)
  VALUES (p_account, p_customer, p_contact, p_role, p_authorised, p_actor, v_now, p_actor, v_now)
  ON CONFLICT (customer_id, contact_id) DO UPDATE
     SET role = excluded.role, authorised = excluded.authorised,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING (xmax = 0) INTO v_created;
  RETURN v_created;
END;
$$;

-- Unlink a contact. Returns true when a row was removed.
CREATE OR REPLACE FUNCTION public.desk_customer_contact_remove(p_actor uuid, p_account uuid, p_customer uuid,
  p_contact uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_remove', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  IF NOT public.desk_customer_can_manage(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_remove', 'NOT_ALLOWED', 'you cannot change this company');
  END IF;
  DELETE FROM public.desk_customer_contacts l
   WHERE l.customer_id = p_customer AND l.contact_id = p_contact AND l.account_id = p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 6. For routing (no actor: the inbound pipeline's question) ----------

-- The companies a contact (a phone) acts for in the workspace. Routing
-- treats more than one as ambiguous and never picks by phone alone.
CREATE OR REPLACE FUNCTION public.desk_customers_for_contact(p_account uuid, p_contact uuid)
RETURNS TABLE (customer_id uuid, legal_name text, trade_licence_no text, role text, authorised boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d.id, d.legal_name, d.trade_licence_no, l.role, l.authorised
    FROM public.desk_customer_contacts l
    JOIN public.desk_customers d ON d.id = l.customer_id AND d.account_id = l.account_id
   WHERE l.account_id = p_account AND l.contact_id = p_contact AND d.merged_into IS NULL
   ORDER BY d.legal_name, d.id
$$;

-- ---------- 7. A desk case's own contact is linked automatically ----------

CREATE OR REPLACE FUNCTION public.desk_case_link_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.desk_customer_id IS NOT NULL AND NEW.contact_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.desk_customer_contacts (account_id, customer_id, contact_id, role, authorised, added_by)
      VALUES (NEW.account_id, NEW.desk_customer_id, NEW.contact_id, 'other', false, NULL)
      ON CONFLICT (customer_id, contact_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      -- Never fail the case write over a convenience link.
      RAISE WARNING 'desk_case_link_contact: link not written (%)', SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cases_desk_link_contact ON public.cases;
CREATE TRIGGER cases_desk_link_contact
  AFTER INSERT OR UPDATE OF desk_customer_id, contact_id ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.desk_case_link_contact();

-- Backfill: every existing desk case's contact (idempotent).
INSERT INTO public.desk_customer_contacts (account_id, customer_id, contact_id, role, authorised, added_by)
SELECT DISTINCT k.account_id, k.desk_customer_id, k.contact_id, 'other', false, NULL::uuid
  FROM public.cases k
 WHERE k.desk_customer_id IS NOT NULL AND k.contact_id IS NOT NULL
ON CONFLICT (customer_id, contact_id) DO NOTHING;

-- ---------- 8. Privacy: exported, kept on erasure ----------

CREATE OR REPLACE FUNCTION public.privacy_desk_contacts_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'company', d.legal_name, 'trade_licence_no', d.trade_licence_no,
           'role', l.role, 'authorised', l.authorised,
           'linked_at', l.created_at, 'updated_at', l.updated_at) ORDER BY l.created_at), '[]'::jsonb)
    FROM public.desk_customer_contacts l
    JOIN public.desk_customers d ON d.id = l.customer_id
   WHERE l.account_id = p_account AND l.contact_id = p_contact
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('desk_company_links', 'privacy_desk_contacts_export', NULL, '229')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 9. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_customer_can_read(uuid, uuid, uuid), public.desk_customer_can_manage(uuid, uuid, uuid),
  public.desk_customer_find(uuid, uuid, text, integer),
  public.desk_customer_contacts_list(uuid, uuid, uuid),
  public.desk_customer_contact_set(uuid, uuid, uuid, uuid, text, boolean, timestamptz),
  public.desk_customer_contact_remove(uuid, uuid, uuid, uuid),
  public.desk_customers_for_contact(uuid, uuid), public.desk_case_link_contact(),
  public.privacy_desk_contacts_export(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_customer_find(uuid, uuid, text, integer),
  public.desk_customer_contacts_list(uuid, uuid, uuid),
  public.desk_customer_contact_set(uuid, uuid, uuid, uuid, text, boolean, timestamptz),
  public.desk_customer_contact_remove(uuid, uuid, uuid, uuid),
  public.desk_customers_for_contact(uuid, uuid)
TO service_role;
