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

-- Add ai_events column to public.drafts if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'drafts' 
          AND column_name = 'ai_events'
    ) THEN
        ALTER TABLE public.drafts ADD COLUMN ai_events JSONB DEFAULT '[]'::jsonb;
    END IF;
END $$;

-- Update public.chat_messages table
DO $$
BEGIN
    -- Add file_diffs column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'chat_messages' 
          AND column_name = 'file_diffs'
    ) THEN
        ALTER TABLE public.chat_messages ADD COLUMN file_diffs JSONB;
    END IF;

    -- Add safety_block column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'chat_messages' 
          AND column_name = 'safety_block'
    ) THEN
        ALTER TABLE public.chat_messages ADD COLUMN safety_block JSONB;
    END IF;
END $$;

-- Update check constraint on role in public.chat_messages
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_role_check CHECK (role IN ('user', 'assistant', 'system', 'agent'));


