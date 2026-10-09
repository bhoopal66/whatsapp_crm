-- Regression check for migration 079: ai_configs.reply_on_all_numbers.
--
-- Asserts the column is a NOT NULL boolean defaulting to false, so an
-- account that never saves the switch keeps the routed-number bot.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the exception.

DO $verify$
DECLARE
  col RECORD;
  failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO col
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'ai_configs'
     AND column_name = 'reply_on_all_numbers';

  IF NOT FOUND THEN
    failures := failures || 'reply_on_all_numbers column missing';
  ELSE
    IF col.data_type <> 'boolean' THEN
      failures := failures || ('type is ' || col.data_type);
    END IF;
    IF col.is_nullable <> 'NO' THEN
      failures := failures || 'column is nullable'::TEXT;
    END IF;
    IF col.column_default IS DISTINCT FROM 'false' THEN
      failures := failures ||
        ('default is ' || COALESCE(col.column_default, 'NULL'));
    END IF;
  END IF;

  IF array_length(failures, 1) > 0 THEN
    RAISE EXCEPTION 'verify-ai-all-numbers failed: %',
      array_to_string(failures, '; ');
  END IF;
END
$verify$;
