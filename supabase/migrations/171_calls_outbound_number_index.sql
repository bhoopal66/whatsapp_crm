-- ============================================================
-- 171_calls_outbound_number_index.sql — find who last called a number.
--
-- An inbound WhatsApp message on a chat nobody holds looks up the
-- newest outbound call to the sender's number
-- (src/lib/pbx/assign-from-calls.ts). A number that was never called
-- is the common answer, and without this index that answer means
-- reading every call of the workspace on every such message.
--
-- Speed only: the lookup gives the same answer without it.
--
-- Re-runnable: IF NOT EXISTS.
-- ============================================================

CREATE INDEX IF NOT EXISTS calls_outbound_number_idx
  ON public.calls (account_id, remote_number, started_at DESC)
  WHERE direction = 'outbound' AND remote_number IS NOT NULL;
