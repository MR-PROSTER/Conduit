-- Migration Patch for Conduit
-- Safe to re-run repeatedly

-- Enable uuid-ossp extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Example safe-to-rerun migration query (ensuring RPC function exec_sql exists for future raw queries)
CREATE OR REPLACE FUNCTION exec_sql(sql text)
RETURNS void AS $$
BEGIN
    EXECUTE sql;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
