-- Custom SQL migration file, put your code below! --
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_search;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_search extension is not available or deprecated on this database, skipping: %', SQLERRM;
END $$;