-- ============================================================
-- 121_vault.sql — sensitive-value vault (encrypted originals, tokens
-- in their place, role-gated reveal)
--
-- A sensitive value (Emirates ID, IBAN, passport, phone, account
-- number, trade licence) is kept encrypted here and a stable,
-- value-independent token takes its place everywhere else. Only a
-- vault admin / super_admin of the account can reveal it, for a stated
-- reason, rate limited and audited. Port of module 019c.
--
--  * The APP encrypts (AES-256-GCM) and computes the blind index
--    (HMAC-SHA256 of the normalised value, separate key); the database
--    never sees a plaintext value or any key. Every call runs as
--    service_role through a vault_* SECURITY DEFINER function;
--    service_role has no table privileges.
--  * vault_items: one encrypted value. token = 'vlt_' + 26 letters of
--    a 16-letter alphabet, generated HERE from gen_random_uuid() (104
--    random bits), never derived from the value; letters only, so no
--    redactor ever matches inside a token. One live item per
--    (account, kind, blind_index): vault_put dedupes onto it and
--    returns the live item's token. kind is EID | IBAN | PASSPORT |
--    PHONE | ACCOUNT | TRADE_LICENCE; CARD, CVV, OTP and PIN are
--    REFUSED by the CHECK (PCI-DSS forbids storing CVV / PIN after
--    authorisation, a PAN needs a PCI-certified vault, an OTP is a live
--    credential). The subject (contact | case, a uuid) has no FK: an
--    item outlives its subject. Rows are never removed; the only
--    updates are a rewrap (new ciphertext / iv / tag / key_id) and the
--    final soft delete (payload wiped, blind_index nulled).
--  * vault_roles: admin | super_admin per account. The caller's role is
--    resolved ONLY inside these functions (vault_has_role), never taken
--    as an argument. wacrm tightening: an active row counts only while
--    its holder is also a live owner or admin profile of that account
--    (profiles.deactivated_at IS NULL, account_role owner/admin), so a
--    demoted or deactivated person loses the vault with the account
--    role. Only super_admin grants / revokes / rewraps; a grant to
--    someone who is not a live owner/admin is DENIED (NOT_ADMIN).
--    Bootstrap only while the account has zero active rows, and only
--    for a live OWNER of it (NOT_OWNER). The last super_admin who
--    still counts cannot be revoked. Rows are never removed; revoke
--    sets revoked_at.
--  * vault_audit: append-only (UPDATE / DELETE / TRUNCATE refused,
--    owner included). Every put / dedupe / reveal / delete / rewrap /
--    role change AND every refused attempt, with token, kind, subject,
--    key ids and the checked reason text. Never a value, a blind index
--    or ciphertext. Read back through vault_audit_list (vault role
--    holders only; reading is not audited).
--  * Reveal: role required, reason required (vault_reason_problem
--    refuses identifiers), 20 attempts per actor per rolling hour.
--  * Refusals are RETURNED as a status (not raised) so the audit row of
--    a refused attempt commits with it. vault_reveal and the three
--    role functions serialise on advisory locks and RAISE 25000 unless
--    the transaction is READ COMMITTED (under a snapshot taken before
--    the lock the check after it is stale).
--  * RLS forced on every table with no policy: only the owner of the
--    SECURITY DEFINER functions (a superuser / BYPASSRLS role) reads or
--    writes them. Actor / user ids are auth user ids (profiles.user_id)
--    without an FK: audit rows outlive people.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 115,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '121 must be applied by a superuser or BYPASSRLS role (the vault_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Token generator ----------

-- 26 letters from 'ghjkmnpqrstvwxyz' (one per hex nibble) of a v4 uuid
-- with its fixed version and variant nibbles dropped: 104 random bits.
CREATE OR REPLACE FUNCTION public.vault_new_token()
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  select 'vlt_' || translate(substr(h, 1, 12) || substr(h, 14, 3) || substr(h, 18, 11),
                             '0123456789abcdef', 'ghjkmnpqrstvwxyz')
    from (select replace(gen_random_uuid()::text, '-', '') as h) u
$$;

-- ---------- 2. Tables ----------

CREATE TABLE IF NOT EXISTS public.vault_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES public.accounts(id),
  token        text        NOT NULL UNIQUE DEFAULT public.vault_new_token()
                           CHECK (token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$'),
  kind         text        NOT NULL,
  ciphertext   bytea       NOT NULL,
  iv           bytea       NOT NULL,
  auth_tag     bytea       NOT NULL,
  key_id       text        NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  subject_type text        NOT NULL CHECK (subject_type IN ('contact', 'case')),
  subject_id   uuid        NOT NULL,
  blind_index  text        CHECK (blind_index ~ '^[0-9a-f]{64}$'),
  created_by   uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  -- live: a GCM payload (12-byte iv, 16-byte tag) and a blind index; deleted: all of it wiped.
  CONSTRAINT vault_items_payload CHECK (
    (deleted_at IS NULL AND octet_length(iv) = 12 AND octet_length(auth_tag) = 16
       AND octet_length(ciphertext) BETWEEN 1 AND 4096 AND blind_index IS NOT NULL AND deleted_by IS NULL)
    OR
    (deleted_at IS NOT NULL AND octet_length(iv) = 0 AND octet_length(auth_tag) = 0
       AND octet_length(ciphertext) = 0 AND blind_index IS NULL AND deleted_by IS NOT NULL))
);
-- Re-apply: the kind check is (re)defined here so it always matches this file. NO card / CVV / OTP / PIN.
ALTER TABLE public.vault_items DROP CONSTRAINT IF EXISTS vault_items_kind_check;
ALTER TABLE public.vault_items ADD CONSTRAINT vault_items_kind_check
  CHECK (kind IN ('EID', 'IBAN', 'PASSPORT', 'PHONE', 'ACCOUNT', 'TRADE_LICENCE'));
CREATE UNIQUE INDEX IF NOT EXISTS vault_items_live_blind_uq
  ON public.vault_items (account_id, kind, blind_index) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vault_items_key_idx ON public.vault_items (account_id, key_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vault_items_subject_idx ON public.vault_items (account_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS public.vault_roles (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid        NOT NULL REFERENCES public.accounts(id),
  user_id      uuid        NOT NULL,
  role         text        NOT NULL CHECK (role IN ('admin', 'super_admin')),
  granted_by   uuid        NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at   timestamptz,
  revoked_by   uuid,
  CONSTRAINT vault_roles_revoke CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)
                                       AND (revoked_at IS NULL OR revoked_at >= granted_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS vault_roles_active_uq
  ON public.vault_roles (account_id, user_id, role) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.vault_audit (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  action       text        NOT NULL,
  outcome      text        NOT NULL,
  actor        uuid        NOT NULL,
  account_id   uuid        NOT NULL REFERENCES public.accounts(id),
  token        text,
  kind         text,
  subject_type text,
  subject_id   uuid,
  reason       text        CHECK (reason IS NULL OR char_length(reason) <= 500),
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);
-- Re-apply: the action / outcome checks are (re)defined here so they always match this file.
ALTER TABLE public.vault_audit DROP CONSTRAINT IF EXISTS vault_audit_action_check;
ALTER TABLE public.vault_audit ADD CONSTRAINT vault_audit_action_check
  CHECK (action IN ('put', 'dedupe', 'reveal', 'reveal_failed', 'delete', 'rewrap_read', 'rewrap',
                    'role_grant', 'role_revoke', 'role_bootstrap'));
ALTER TABLE public.vault_audit DROP CONSTRAINT IF EXISTS vault_audit_outcome_check;
ALTER TABLE public.vault_audit ADD CONSTRAINT vault_audit_outcome_check
  CHECK (outcome IN ('OK', 'DENIED', 'NOT_FOUND', 'RATE_LIMITED', 'CONFLICT', 'DECRYPT_FAILED'));
CREATE INDEX IF NOT EXISTS vault_audit_rate_idx ON public.vault_audit (actor, action, at);
CREATE INDEX IF NOT EXISTS vault_audit_account_idx ON public.vault_audit (account_id, at);

-- No policies: FORCE binds the owner too, so only a superuser /
-- BYPASSRLS role (the owner of the vault_* functions) passes.
ALTER TABLE public.vault_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vault_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vault_audit FORCE ROW LEVEL SECURITY;

-- ---------- 3. Guards (owner included) ----------

CREATE OR REPLACE FUNCTION public.vault_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null then
      raise exception 'public.vault_items: an item is inserted live (INSERT refused)' using errcode = 'insufficient_privilege';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if (new.id, new.account_id, new.token, new.kind, new.subject_type, new.subject_id, new.created_by, new.created_at)
       is distinct from
       (old.id, old.account_id, old.token, old.kind, old.subject_type, old.subject_id, old.created_by, old.created_at) then
      raise exception 'public.vault_items: the item identity is fixed (UPDATE refused)' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'public.vault_items: a deleted item is final (UPDATE refused)' using errcode = 'insufficient_privilege';
    end if;
    if new.deleted_at is null and new.blind_index is distinct from old.blind_index then
      raise exception 'public.vault_items: blind_index is fixed (UPDATE refused)' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  raise exception 'public.vault_items: rows are never removed; use vault_delete (% refused)', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

CREATE OR REPLACE FUNCTION public.vault_roles_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  if tg_op = 'UPDATE' then
    if old.revoked_at is null and new.revoked_at is not null
       and (new.id, new.account_id, new.user_id, new.role, new.granted_by, new.granted_at)
           is not distinct from (old.id, old.account_id, old.user_id, old.role, old.granted_by, old.granted_at) then
      return new;
    end if;
    raise exception 'public.vault_roles: the only change is revoking an active row (UPDATE refused)'
      using errcode = 'insufficient_privilege';
  end if;
  raise exception 'public.vault_roles: rows are never removed (% refused)', tg_op using errcode = 'insufficient_privilege';
end
$$;

CREATE OR REPLACE FUNCTION public.vault_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  raise exception 'public.% is append-only (% refused)', tg_table_name, tg_op using errcode = 'insufficient_privilege';
end
$$;

DROP TRIGGER IF EXISTS vault_items_guard ON public.vault_items;
CREATE TRIGGER vault_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.vault_items
  FOR EACH ROW EXECUTE FUNCTION public.vault_items_guard();
DROP TRIGGER IF EXISTS vault_items_no_truncate ON public.vault_items;
CREATE TRIGGER vault_items_no_truncate
  BEFORE TRUNCATE ON public.vault_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.vault_append_only();
DROP TRIGGER IF EXISTS vault_roles_guard ON public.vault_roles;
CREATE TRIGGER vault_roles_guard
  BEFORE UPDATE OR DELETE ON public.vault_roles
  FOR EACH ROW EXECUTE FUNCTION public.vault_roles_guard();
DROP TRIGGER IF EXISTS vault_roles_no_truncate ON public.vault_roles;
CREATE TRIGGER vault_roles_no_truncate
  BEFORE TRUNCATE ON public.vault_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.vault_append_only();
DROP TRIGGER IF EXISTS vault_audit_append_only ON public.vault_audit;
CREATE TRIGGER vault_audit_append_only
  BEFORE UPDATE OR DELETE ON public.vault_audit
  FOR EACH ROW EXECUTE FUNCTION public.vault_append_only();
DROP TRIGGER IF EXISTS vault_audit_no_truncate ON public.vault_audit;
CREATE TRIGGER vault_audit_no_truncate
  BEFORE TRUNCATE ON public.vault_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.vault_append_only();

-- ---------- 4. Internal helpers (no EXECUTE for any API role) ----------

-- A live profile of the account holding one of the given account roles
-- (deactivated_at IS NULL; a person may hold rows in several accounts,
-- only this account's row counts).
CREATE OR REPLACE FUNCTION public.vault_live_profile(p_account uuid, p_user uuid, p_account_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (select 1 from public.profiles p
                  where p.user_id = p_user and p.account_id = p_account and p.deactivated_at is null
                    and p.account_role::text = any (p_account_roles))
$$;

-- The one place the caller's vault role is resolved: an active
-- vault_roles row of one of p_roles AND a live owner / admin profile of
-- the same account. Every vault_* function inherits the profile rule.
CREATE OR REPLACE FUNCTION public.vault_has_role(p_account uuid, p_user uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (select 1 from public.vault_roles r
                  where r.account_id = p_account and r.user_id = p_user and r.revoked_at is null
                    and r.role = any (p_roles))
     and public.vault_live_profile(p_account, p_user, array['owner', 'admin'])
$$;

-- Audit detail for caller-supplied text: the audit is append-only, so raw input never goes in unvalidated.
-- vault_audit_role: {role} for a valid role (admin / super_admin), else {role_valid: false, role_len} only.
-- vault_audit_text: control and invisible characters (C0, DEL, C1, zero-width, bidi embeddings / overrides, word
-- joiner .. U+206F, BOM) are stripped first; the 64-character limit and the stored length use the stripped value.
-- Up to 64 characters stores {name: stripped}; longer stores {name_len: n} only; null stores {}.
CREATE OR REPLACE FUNCTION public.vault_audit_role(p_role text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  select case when p_role in ('admin', 'super_admin') then jsonb_build_object('role', p_role)
              else jsonb_build_object('role_valid', false, 'role_len', char_length(p_role)) end
$$;

CREATE OR REPLACE FUNCTION public.vault_audit_text(p_name text, p_value text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  select case when x.v is null then '{}'::jsonb
              when char_length(x.v) <= 64 then jsonb_build_object(p_name, x.v)
              else jsonb_build_object(p_name || '_len', char_length(x.v)) end
  from (select regexp_replace(p_value, E'[\\u0001-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]',
                              '', 'g') as v) x
$$;

-- null = acceptable reason; else why it is refused. Reasons are free text and must not carry identifiers. The reason is
-- normalised first: NFKC (fullwidth and other compatibility digits become ASCII). Refused first (NON_ASCII_DIGITS):
-- any decimal digit of a script other than ASCII left after NFKC (Arabic-Indic, Persian, NKo, Devanagari, Bengali,
-- Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian,
-- Limbu, New Tai Lue, Tai Tham, Balinese, Sundanese, Lepcha, Ol Chiki, Vai, Saurashtra, Kayah Li, Javanese, Cham,
-- Meetei Mayek, fullwidth): such digits are never counted, so one Devanagari EID would otherwise pass. Then Arabic-Indic
-- (U+0660-0669), Persian (U+06F0-06F9) and fullwidth (U+FF10-FF19) digits are translated to ASCII and refused
-- (REASON_HAS_IDENTIFIER): 12+ digits in total; a run of 7+ digits once EVERY character that is not a letter or digit
-- is removed (EID, IBAN, account, card, phone, and also a numeric date such as 2026-10-18); a passport-like token (one
-- letter, up to 3 separator characters, 6-8 digits: 'Z - 654321'); 'AE' + 2 digits + 10 or more digits once separators
-- are removed; an AE IBAN prefix.
CREATE OR REPLACE FUNCTION public.vault_reason_problem(p_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  select case
    when p_reason is null or btrim(p_reason) = '' then 'REASON_REQUIRED'
    when char_length(p_reason) > 500 then 'REASON_TOO_LONG'
    when normalize(p_reason, NFKC) ~ (E'[\\u0660-\\u0669\\u06F0-\\u06F9\\u07C0-\\u07C9\\u0966-\\u096F\\u09E6-\\u09EF\\u0A66-\\u0A6F'
                  || E'\\u0AE6-\\u0AEF\\u0B66-\\u0B6F\\u0BE6-\\u0BEF\\u0C66-\\u0C6F\\u0CE6-\\u0CEF\\u0D66-\\u0D6F'
                  || E'\\u0DE6-\\u0DEF\\u0E50-\\u0E59\\u0ED0-\\u0ED9\\u0F20-\\u0F29\\u1040-\\u1049\\u1090-\\u1099'
                  || E'\\u17E0-\\u17E9\\u1810-\\u1819\\u1946-\\u194F\\u19D0-\\u19D9\\u1A80-\\u1A89\\u1A90-\\u1A99'
                  || E'\\u1B50-\\u1B59\\u1BB0-\\u1BB9\\u1C40-\\u1C49\\u1C50-\\u1C59\\uA620-\\uA629\\uA8D0-\\uA8D9'
                  || E'\\uA900-\\uA909\\uA9D0-\\uA9D9\\uA9F0-\\uA9F9\\uAA50-\\uAA59\\uABF0-\\uABF9\\uFF10-\\uFF19]') then 'NON_ASCII_DIGITS'
    when char_length(regexp_replace(x.n, '[^0-9]', '', 'g')) >= 12
      or regexp_replace(x.n, '[^[:alnum:]]', '', 'g') ~ '[0-9]{7}'
      or x.n ~ '(^|[^[:alnum:]])[[:alpha:]][^[:alnum:]]{0,3}[0-9]{6,8}([^0-9]|$)'
      or regexp_replace(x.n, '[^[:alnum:]]', '', 'g') ~* 'AE[0-9]{12}'
      or x.n ~* 'AE[[:space:]]?[0-9]{2}' then 'REASON_HAS_IDENTIFIER'
  end
  from (select translate(normalize(p_reason, NFKC),
                         E'٠١٢٣٤٥٦٧٨٩'
                         || E'۰۱۲۳۴۵۶۷۸۹'
                         || E'０１２３４５６７８９',
                         '012345678901234567890123456789') as n) x
$$;

-- ---------- 5. Write path ----------

-- No role needed (the app writes on behalf of the system), audited. Dedupe onto the live item with the same
-- (account, kind, blind_index): its token is returned, nothing is stored. Serialised per blind index.
-- Returns status OK (put or dedupe) | DENIED (BAD_SUBJECT: subject type not contact / case, or subject id NULL;
-- audited, null token / deduped).
DROP FUNCTION IF EXISTS public.vault_put(uuid, uuid, text, bytea, bytea, bytea, text, text, text, uuid);
CREATE FUNCTION public.vault_put(
  p_actor uuid, p_account uuid, p_kind text, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_key_id text,
  p_blind_index text, p_subject_type text, p_subject_id uuid)
RETURNS TABLE (status text, token text, deduped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item public.vault_items%rowtype;
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_put: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_subject_type is null or p_subject_type not in ('contact', 'case') or p_subject_id is null then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('put', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'BAD_SUBJECT'));
    return query select 'DENIED'::text, null::text, null::boolean;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('vault:put:' || p_account::text || ':' || coalesce(p_kind, '') || ':' || coalesce(p_blind_index, '')));
  select * into v_item from public.vault_items i
   where i.account_id = p_account and i.kind = p_kind and i.blind_index = p_blind_index and i.deleted_at is null;
  if found then
    insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, detail)
    values ('dedupe', 'OK', p_actor, p_account, v_item.token, v_item.kind, p_subject_type, p_subject_id,
            jsonb_build_object('subject_differs', (v_item.subject_type, v_item.subject_id) is distinct from (p_subject_type, p_subject_id)));
    return query select 'OK'::text, v_item.token, true;
    return;
  end if;
  insert into public.vault_items (account_id, kind, ciphertext, iv, auth_tag, key_id, subject_type, subject_id, blind_index, created_by)
  values (p_account, p_kind, p_ciphertext, p_iv, p_auth_tag, p_key_id, p_subject_type, p_subject_id, p_blind_index, p_actor)
  returning * into v_item;
  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, detail)
  values ('put', 'OK', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type, v_item.subject_id,
          jsonb_build_object('key_id', v_item.key_id));
  return query select 'OK'::text, v_item.token, false;
end
$$;

-- ---------- 6. Reveal ----------

-- An admin / super_admin of THIS account (vault_has_role), an acceptable reason, at most 20 reveal attempts per actor
-- per rolling hour (all accounts; refused-for-rate attempts do not count; serialised per actor so the count cannot be
-- raced). Every attempt writes one audit row and the status is RETURNED:
--   OK (with the payload) | DENIED (no role / bad reason) | RATE_LIMITED | NOT_FOUND (unknown token, other account's
--   token, deleted item). Only OK carries a payload, with the item's blind_index (part of the AAD the app decrypts
--   under).
DROP FUNCTION IF EXISTS public.vault_reveal(uuid, uuid, text, text);
CREATE FUNCTION public.vault_reveal(p_actor uuid, p_account uuid, p_token text, p_reason text)
RETURNS TABLE (status text, kind text, ciphertext bytea, iv bytea, auth_tag bytea, key_id text, blind_index text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item    public.vault_items%rowtype;
  v_problem text;
  v_tok     text := case when p_token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' then p_token end;
  v_reason  text;
  v_n       integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'vault_reveal: requires READ COMMITTED (advisory locks do not serialise under a snapshot taken before the lock)'
      using errcode = 'invalid_transaction_state';
  end if;
  if p_actor is null or p_account is null then
    raise exception 'vault_reveal: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('vault:reveal:' || p_actor::text));
  v_problem := public.vault_reason_problem(p_reason);
  v_reason := case when v_problem is null then p_reason end;

  if not public.vault_has_role(p_account, p_actor, array['admin', 'super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, token, reason, detail)
    values ('reveal', 'DENIED', p_actor, p_account, v_tok, v_reason, jsonb_build_object('why', 'NO_ROLE'));
    return query select 'DENIED'::text, null::text, null::bytea, null::bytea, null::bytea, null::text, null::text;
    return;
  end if;

  if v_problem is not null then
    insert into public.vault_audit (action, outcome, actor, account_id, token, detail)
    values ('reveal', 'DENIED', p_actor, p_account, v_tok, jsonb_build_object('why', v_problem));
    return query select 'DENIED'::text, null::text, null::bytea, null::bytea, null::bytea, null::text, null::text;
    return;
  end if;

  select count(*) into v_n from public.vault_audit a
   where a.actor = p_actor and a.action = 'reveal' and a.outcome <> 'RATE_LIMITED'
     and a.at > clock_timestamp() - interval '1 hour';
  if v_n >= 20 then
    insert into public.vault_audit (action, outcome, actor, account_id, token, reason, detail)
    values ('reveal', 'RATE_LIMITED', p_actor, p_account, v_tok, v_reason, jsonb_build_object('window_count', v_n));
    return query select 'RATE_LIMITED'::text, null::text, null::bytea, null::bytea, null::bytea, null::text, null::text;
    return;
  end if;

  select * into v_item from public.vault_items i
   where i.token = v_tok and i.account_id = p_account and i.deleted_at is null;
  if not found then
    insert into public.vault_audit (action, outcome, actor, account_id, token, reason)
    values ('reveal', 'NOT_FOUND', p_actor, p_account, v_tok, v_reason);
    return query select 'NOT_FOUND'::text, null::text, null::bytea, null::bytea, null::bytea, null::text, null::text;
    return;
  end if;

  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, reason, detail)
  values ('reveal', 'OK', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type, v_item.subject_id,
          v_reason, jsonb_build_object('key_id', v_item.key_id));
  return query select 'OK'::text, v_item.kind, v_item.ciphertext, v_item.iv, v_item.auth_tag, v_item.key_id, v_item.blind_index;
end
$$;

-- Reveal failure report: the app calls this when the payload vault_reveal returned does not decrypt (tampered or
-- swapped row, unknown or invalid key). Same role resolution as vault_reveal and the token must name an item of this
-- account (a deleted one included: it was live when revealed). Returns OK | DENIED | NOT_FOUND; DENIED and NOT_FOUND
-- write nothing. OK writes one audit row with action 'reveal_failed' (NOT 'reveal': the rate limit counts
-- action = 'reveal' rows, and the reveal itself was already audited and counted), outcome DECRYPT_FAILED, the item's
-- kind / subject and detail {key_id}.
CREATE OR REPLACE FUNCTION public.vault_reveal_failed(p_actor uuid, p_account uuid, p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item public.vault_items%rowtype;
  v_tok  text := case when p_token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' then p_token end;
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_reveal_failed: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  if not public.vault_has_role(p_account, p_actor, array['admin', 'super_admin']) then
    return 'DENIED';
  end if;
  select * into v_item from public.vault_items i where i.token = v_tok and i.account_id = p_account;
  if not found then
    return 'NOT_FOUND';
  end if;
  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, detail)
  values ('reveal_failed', 'DECRYPT_FAILED', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type,
          v_item.subject_id, jsonb_build_object('key_id', v_item.key_id));
  return 'OK';
end
$$;

-- ---------- 7. Delete (erasure) ----------

-- admin / super_admin, a reason; soft delete that wipes ciphertext / iv / tag and the blind index; the row (token,
-- kind, subject, timestamps) stays for the audit trail. Returns OK | DENIED | NOT_FOUND, always audited.
CREATE OR REPLACE FUNCTION public.vault_delete(p_actor uuid, p_account uuid, p_token text, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item    public.vault_items%rowtype;
  v_problem text;
  v_tok     text := case when p_token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' then p_token end;
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_delete: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  v_problem := public.vault_reason_problem(p_reason);
  if not public.vault_has_role(p_account, p_actor, array['admin', 'super_admin']) or v_problem is not null then
    insert into public.vault_audit (action, outcome, actor, account_id, token, reason, detail)
    values ('delete', 'DENIED', p_actor, p_account, v_tok, case when v_problem is null then p_reason end,
            jsonb_build_object('why', coalesce(v_problem, 'NO_ROLE')));
    return 'DENIED';
  end if;
  update public.vault_items i
     set deleted_at = clock_timestamp(), deleted_by = p_actor, ciphertext = '\x'::bytea, iv = '\x'::bytea,
         auth_tag = '\x'::bytea, blind_index = null
   where i.token = v_tok and i.account_id = p_account and i.deleted_at is null
  returning * into v_item;
  if not found then
    insert into public.vault_audit (action, outcome, actor, account_id, token, reason)
    values ('delete', 'NOT_FOUND', p_actor, p_account, v_tok, p_reason);
    return 'NOT_FOUND';
  end if;
  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, reason)
  values ('delete', 'OK', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type, v_item.subject_id, p_reason);
  return 'OK';
end
$$;

-- ---------- 8. Key rotation (super_admin only, audited) ----------

-- vault_rewrap_candidates lists live items still under p_old_key_id (ciphertext only; the app decrypts and
-- re-encrypts); vault_rewrap swaps the payload of one item when its key_id is still p_expected_key_id (else CONFLICT:
-- a concurrent rewrap or delete won). Candidates carry blind_index (part of the AAD; rewrap re-encrypts under the
-- same one). Keyset paging: pass the last row's (created_at, id) as (p_after_created_at, p_after_id) to list the items
-- after it (both null: from the start). A cursor, not an offset: OK rewraps leave the set, DECRYPT_FAILED items stay.
DROP FUNCTION IF EXISTS public.vault_rewrap_candidates(uuid, uuid, text, integer, timestamptz, uuid);
CREATE FUNCTION public.vault_rewrap_candidates(p_actor uuid, p_account uuid, p_old_key_id text, p_limit integer,
                                               p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (status text, token text, kind text, ciphertext bytea, iv bytea, auth_tag bytea, key_id text, blind_index text,
               created_at timestamptz, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_row    record;
  v_tokens text[] := '{}';
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_rewrap_candidates: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'vault_rewrap_candidates: p_limit must be 1..500' using errcode = 'invalid_parameter_value';
  end if;
  if not public.vault_has_role(p_account, p_actor, array['super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('rewrap_read', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'NO_ROLE')
            || public.vault_audit_text('old_key_id', p_old_key_id));
    return query select 'DENIED'::text, null::text, null::text, null::bytea, null::bytea, null::bytea, null::text, null::text,
                        null::timestamptz, null::uuid;
    return;
  end if;
  -- The OK audit row lists every returned token (tokens are random, never a value).
  for v_row in
    select i.token, i.kind, i.ciphertext, i.iv, i.auth_tag, i.key_id, i.blind_index, i.created_at, i.id
      from public.vault_items i
     where i.account_id = p_account and i.key_id = p_old_key_id and i.deleted_at is null
       and (p_after_created_at is null or p_after_id is null or (i.created_at, i.id) > (p_after_created_at, p_after_id))
     order by i.created_at, i.id
     limit p_limit
  loop
    status := 'OK'; token := v_row.token; kind := v_row.kind; ciphertext := v_row.ciphertext; iv := v_row.iv;
    auth_tag := v_row.auth_tag; key_id := v_row.key_id; blind_index := v_row.blind_index;
    created_at := v_row.created_at; id := v_row.id;
    return next;
    v_tokens := v_tokens || v_row.token;
  end loop;
  insert into public.vault_audit (action, outcome, actor, account_id, detail)
  values ('rewrap_read', 'OK', p_actor, p_account,
          jsonb_build_object('tokens', to_jsonb(coalesce(v_tokens, '{}')), 'count', cardinality(v_tokens))
          || public.vault_audit_text('old_key_id', p_old_key_id));
end
$$;

CREATE OR REPLACE FUNCTION public.vault_rewrap(p_actor uuid, p_account uuid, p_token text, p_expected_key_id text,
                                               p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_new_key_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item public.vault_items%rowtype;
  v_tok  text := case when p_token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' then p_token end;
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_rewrap: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  if not public.vault_has_role(p_account, p_actor, array['super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, token, detail)
    values ('rewrap', 'DENIED', p_actor, p_account, v_tok, jsonb_build_object('why', 'NO_ROLE'));
    return 'DENIED';
  end if;
  select * into v_item from public.vault_items i
   where i.token = v_tok and i.account_id = p_account and i.deleted_at is null
   for update;
  if not found then
    insert into public.vault_audit (action, outcome, actor, account_id, token)
    values ('rewrap', 'NOT_FOUND', p_actor, p_account, v_tok);
    return 'NOT_FOUND';
  end if;
  if v_item.key_id is distinct from p_expected_key_id then
    insert into public.vault_audit (action, outcome, actor, account_id, token, kind, detail)
    values ('rewrap', 'CONFLICT', p_actor, p_account, v_item.token, v_item.kind,
            jsonb_build_object('key_id', v_item.key_id) || public.vault_audit_text('expected_key_id', p_expected_key_id));
    return 'CONFLICT';
  end if;
  update public.vault_items i
     set ciphertext = p_ciphertext, iv = p_iv, auth_tag = p_auth_tag, key_id = p_new_key_id
   where i.id = v_item.id;
  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, detail)
  values ('rewrap', 'OK', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type, v_item.subject_id,
          jsonb_build_object('old_key_id', v_item.key_id, 'new_key_id', p_new_key_id));
  return 'OK';
end
$$;

-- Rewrap failure report: the app calls this when a candidate does not decrypt, so the item stays under its old key.
-- Same role rule as vault_rewrap; a refusal is audited like vault_rewrap's (action 'rewrap', DENIED, {why: NO_ROLE}).
-- The token must name an item of this account (a deleted one included); NOT_FOUND writes nothing. OK writes one audit
-- row with action 'rewrap', outcome DECRYPT_FAILED, the item's kind / subject and detail {key_id} (bounded and
-- stripped like other free text). No payload is ever passed. Returns OK | DENIED | NOT_FOUND.
CREATE OR REPLACE FUNCTION public.vault_rewrap_failed(p_actor uuid, p_account uuid, p_token text, p_key_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_item public.vault_items%rowtype;
  v_tok  text := case when p_token ~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' then p_token end;
begin
  if p_actor is null or p_account is null then
    raise exception 'vault_rewrap_failed: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  if not public.vault_has_role(p_account, p_actor, array['super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, token, detail)
    values ('rewrap', 'DENIED', p_actor, p_account, v_tok, jsonb_build_object('why', 'NO_ROLE'));
    return 'DENIED';
  end if;
  select * into v_item from public.vault_items i where i.token = v_tok and i.account_id = p_account;
  if not found then
    return 'NOT_FOUND';
  end if;
  insert into public.vault_audit (action, outcome, actor, account_id, token, kind, subject_type, subject_id, detail)
  values ('rewrap', 'DECRYPT_FAILED', p_actor, p_account, v_item.token, v_item.kind, v_item.subject_type,
          v_item.subject_id, public.vault_audit_text('key_id', p_key_id));
  return 'OK';
end
$$;

-- ---------- 9. Roles ----------

-- Grant / revoke need the CALLER (p_actor) to hold super_admin in the account (vault_has_role: an active row and a
-- live owner / admin profile). Bootstrap: grants super_admin to p_user ONLY while the account has zero active rows
-- (first install, or after every row was revoked) and only to a live OWNER of the account (NOT_OWNER); run it from a
-- deploy / admin script, not from a user request path. A grant to someone who is not a live owner / admin of the
-- account is DENIED (NOT_ADMIN); a role other than admin / super_admin is DENIED (INVALID_ROLE). Revoking a
-- super_admin is refused when no OTHER super_admin who still counts (vault_has_role) would remain
-- (LAST_SUPER_ADMIN): else nobody could grant again while the rows stay active. All serialised per account and
-- audited, refusals included. Returns OK | NOOP (already active / nothing to revoke) | DENIED.
CREATE OR REPLACE FUNCTION public.vault_role_bootstrap(p_actor uuid, p_account uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'vault_role_bootstrap: requires READ COMMITTED (advisory locks do not serialise under a snapshot taken before the lock)'
      using errcode = 'invalid_transaction_state';
  end if;
  if p_actor is null or p_account is null or p_user is null then
    raise exception 'vault_role_bootstrap: actor, account and user are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('vault:roles:' || p_account::text));
  if exists (select 1 from public.vault_roles r where r.account_id = p_account and r.revoked_at is null) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_bootstrap', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'WORKSPACE_HAS_ROLES')
            || public.vault_audit_text('user_id', p_user::text));
    return 'DENIED';
  end if;
  if not public.vault_live_profile(p_account, p_user, array['owner']) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_bootstrap', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'NOT_OWNER')
            || public.vault_audit_text('user_id', p_user::text));
    return 'DENIED';
  end if;
  insert into public.vault_roles (account_id, user_id, role, granted_by) values (p_account, p_user, 'super_admin', p_actor);
  insert into public.vault_audit (action, outcome, actor, account_id, detail)
  values ('role_bootstrap', 'OK', p_actor, p_account, jsonb_build_object('role', 'super_admin')
          || public.vault_audit_text('user_id', p_user::text));
  return 'OK';
end
$$;

CREATE OR REPLACE FUNCTION public.vault_role_grant(p_actor uuid, p_account uuid, p_user uuid, p_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_n integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'vault_role_grant: requires READ COMMITTED (advisory locks do not serialise under a snapshot taken before the lock)'
      using errcode = 'invalid_transaction_state';
  end if;
  if p_actor is null or p_account is null then
    raise exception 'vault_role_grant: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('vault:roles:' || p_account::text));
  if not public.vault_has_role(p_account, p_actor, array['super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_grant', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'NO_ROLE')
            || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
    return 'DENIED';
  end if;
  if p_role is null or p_role not in ('admin', 'super_admin') then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_grant', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'INVALID_ROLE')
            || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
    return 'DENIED';
  end if;
  if p_user is null or not public.vault_live_profile(p_account, p_user, array['owner', 'admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_grant', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'NOT_ADMIN')
            || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
    return 'DENIED';
  end if;
  insert into public.vault_roles (account_id, user_id, role, granted_by) values (p_account, p_user, p_role, p_actor)
  on conflict (account_id, user_id, role) where revoked_at is null do nothing;
  get diagnostics v_n = row_count;
  insert into public.vault_audit (action, outcome, actor, account_id, detail)
  values ('role_grant', 'OK', p_actor, p_account, jsonb_build_object('changed', v_n = 1)
          || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
  return case when v_n = 1 then 'OK' else 'NOOP' end;
end
$$;

CREATE OR REPLACE FUNCTION public.vault_role_revoke(p_actor uuid, p_account uuid, p_user uuid, p_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_n integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'vault_role_revoke: requires READ COMMITTED (advisory locks do not serialise under a snapshot taken before the lock)'
      using errcode = 'invalid_transaction_state';
  end if;
  if p_actor is null or p_account is null then
    raise exception 'vault_role_revoke: actor and account are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('vault:roles:' || p_account::text));
  if not public.vault_has_role(p_account, p_actor, array['super_admin']) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_revoke', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'NO_ROLE')
            || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
    return 'DENIED';
  end if;
  if p_role = 'super_admin'
     and exists (select 1 from public.vault_roles r
                  where r.account_id = p_account and r.user_id = p_user and r.role = 'super_admin' and r.revoked_at is null)
     and not exists (select 1 from public.vault_roles r
                      where r.account_id = p_account and r.role = 'super_admin' and r.revoked_at is null
                        and r.user_id is distinct from p_user
                        and public.vault_has_role(p_account, r.user_id, array['super_admin'])) then
    insert into public.vault_audit (action, outcome, actor, account_id, detail)
    values ('role_revoke', 'DENIED', p_actor, p_account, jsonb_build_object('why', 'LAST_SUPER_ADMIN')
            || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
    return 'DENIED';
  end if;
  update public.vault_roles r set revoked_at = clock_timestamp(), revoked_by = p_actor
   where r.account_id = p_account and r.user_id = p_user and r.role = p_role and r.revoked_at is null;
  get diagnostics v_n = row_count;
  insert into public.vault_audit (action, outcome, actor, account_id, detail)
  values ('role_revoke', 'OK', p_actor, p_account, jsonb_build_object('changed', v_n = 1)
          || public.vault_audit_text('user_id', p_user::text) || public.vault_audit_role(p_role));
  return case when v_n = 1 then 'OK' else 'NOOP' end;
end
$$;

-- ---------- 10. Audit read ----------

-- The account's audit rows, newest first, for a caller who holds a vault role there (vault_has_role, admin or
-- super_admin); anyone else gets zero rows. p_limit is clamped to 1..500 (NULL = 100). Reading is not audited. The
-- audit never holds a value, blind index or ciphertext, so every column is returned.
DROP FUNCTION IF EXISTS public.vault_audit_list(uuid, uuid, integer);
CREATE FUNCTION public.vault_audit_list(p_actor uuid, p_account uuid, p_limit integer DEFAULT 100)
RETURNS TABLE (id bigint, at timestamptz, action text, outcome text, actor uuid, account_id uuid, token text,
               kind text, subject_type text, subject_id uuid, reason text, detail jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select a.id, a.at, a.action, a.outcome, a.actor, a.account_id, a.token, a.kind, a.subject_type, a.subject_id,
         a.reason, a.detail
    from public.vault_audit a
   where a.account_id = p_account
     and public.vault_has_role(p_account, p_actor, array['admin', 'super_admin'])
   order by a.at desc, a.id desc
   limit greatest(1, least(500, coalesce(p_limit, 100)))
$$;

-- ---------- 11. Privileges ----------

-- Start from nothing (a new table, sequence and function grant anon,
-- authenticated and service_role everything by default): no table or
-- sequence privilege for anyone but the owner; service_role executes
-- the API functions only.
REVOKE ALL ON public.vault_items, public.vault_roles, public.vault_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.vault_roles_id_seq, public.vault_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.vault_new_token(),
  public.vault_items_guard(),
  public.vault_roles_guard(),
  public.vault_append_only(),
  public.vault_live_profile(uuid, uuid, text[]),
  public.vault_has_role(uuid, uuid, text[]),
  public.vault_reason_problem(text),
  public.vault_audit_role(text),
  public.vault_audit_text(text, text),
  public.vault_put(uuid, uuid, text, bytea, bytea, bytea, text, text, text, uuid),
  public.vault_reveal(uuid, uuid, text, text),
  public.vault_reveal_failed(uuid, uuid, text),
  public.vault_delete(uuid, uuid, text, text),
  public.vault_rewrap_candidates(uuid, uuid, text, integer, timestamptz, uuid),
  public.vault_rewrap(uuid, uuid, text, text, bytea, bytea, bytea, text),
  public.vault_rewrap_failed(uuid, uuid, text, text),
  public.vault_role_bootstrap(uuid, uuid, uuid),
  public.vault_role_grant(uuid, uuid, uuid, text),
  public.vault_role_revoke(uuid, uuid, uuid, text),
  public.vault_audit_list(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.vault_put(uuid, uuid, text, bytea, bytea, bytea, text, text, text, uuid),
  public.vault_reveal(uuid, uuid, text, text),
  public.vault_reveal_failed(uuid, uuid, text),
  public.vault_delete(uuid, uuid, text, text),
  public.vault_rewrap_candidates(uuid, uuid, text, integer, timestamptz, uuid),
  public.vault_rewrap(uuid, uuid, text, text, bytea, bytea, bytea, text),
  public.vault_rewrap_failed(uuid, uuid, text, text),
  public.vault_role_bootstrap(uuid, uuid, uuid),
  public.vault_role_grant(uuid, uuid, uuid, text),
  public.vault_role_revoke(uuid, uuid, uuid, text),
  public.vault_audit_list(uuid, uuid, integer)
  TO service_role;
