-- Supabase Database Schema for Conduit
-- Enable UUID extension (standard in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================================
-- TABLES & TRIGGERS
-- =========================================================================

-- 1. users
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger function for creating a public user record when an auth user is created
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, email, name, created_at)
    VALUES (
        new.id,
        new.email,
        COALESCE(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', ''),
        COALESCE(new.created_at, NOW())
    )
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name = COALESCE(EXCLUDED.name, public.users.name);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to execute on auth.users insert
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. rooms
CREATE TABLE public.rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_name TEXT NOT NULL,
    repository_owner TEXT,
    repository_remote_url TEXT,
    default_branch TEXT DEFAULT 'main',
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. room_members
CREATE TABLE public.room_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'banned')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    banned_at TIMESTAMPTZ,
    banned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ban_reason TEXT,
    CONSTRAINT unique_room_user UNIQUE (room_id, user_id)
);

-- 4. invitations
CREATE TABLE public.invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    inviter_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    CONSTRAINT unique_room_email UNIQUE (room_id, email)
);

-- 5. sessions
CREATE TABLE public.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    yjs_room_key TEXT UNIQUE,
    base_commit_sha TEXT NOT NULL DEFAULT 'HEAD',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended', 'discarded')),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. drafts
CREATE TABLE public.drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES public.sessions(id) ON DELETE CASCADE,
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
    branch TEXT,
    base_commit_hash TEXT,
    owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    storage_key TEXT UNIQUE,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'applied', 'discarded')),
    lineage TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. draft_filesystem_ops
CREATE TABLE public.draft_filesystem_ops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id UUID REFERENCES public.drafts(id) ON DELETE CASCADE,
    op_index INT NOT NULL,
    op JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. chat_threads
CREATE TABLE public.chat_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    type TEXT CHECK (type IN ('group', 'private-fork', 'public-fork', 'standalone')),
    name TEXT,
    forked_from_message_id UUID, -- Foreign key constraint added after chat_messages creation
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. chat_messages
CREATE TABLE public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID REFERENCES public.chat_threads(id) ON DELETE CASCADE,
    role TEXT CHECK (role IN ('user', 'assistant')),
    content TEXT DEFAULT '',
    model TEXT,
    tokens_used INT,
    context_refs JSONB,
    agent_steps JSONB,
    attachments JSONB,
    sender_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add the foreign key constraint on chat_threads now that chat_messages table exists
ALTER TABLE public.chat_threads
ADD CONSTRAINT fk_chat_threads_forked_message
FOREIGN KEY (forked_from_message_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;


-- =========================================================================
-- INDEXES ON FOREIGN KEYS
-- =========================================================================

-- rooms
CREATE INDEX IF NOT EXISTS idx_rooms_owner_id ON public.rooms(owner_id);

-- room_members
CREATE INDEX IF NOT EXISTS idx_room_members_room_id ON public.room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON public.room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_room_members_banned_by ON public.room_members(banned_by);

-- invitations
CREATE INDEX IF NOT EXISTS idx_invitations_room_id ON public.invitations(room_id);
CREATE INDEX IF NOT EXISTS idx_invitations_inviter_id ON public.invitations(inviter_id);

-- sessions
CREATE INDEX IF NOT EXISTS idx_sessions_room_id ON public.sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON public.sessions(created_by);

-- drafts
CREATE INDEX IF NOT EXISTS idx_drafts_session_id ON public.drafts(session_id);
CREATE INDEX IF NOT EXISTS idx_drafts_room_id ON public.drafts(room_id);
CREATE INDEX IF NOT EXISTS idx_drafts_owner_id ON public.drafts(owner_id);
CREATE INDEX IF NOT EXISTS idx_drafts_created_by ON public.drafts(created_by);

-- draft_filesystem_ops
CREATE INDEX IF NOT EXISTS idx_draft_filesystem_ops_draft_id ON public.draft_filesystem_ops(draft_id);

-- chat_threads
CREATE INDEX IF NOT EXISTS idx_chat_threads_session_id ON public.chat_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_forked_from_message_id ON public.chat_threads(forked_from_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_created_by ON public.chat_threads(created_by);

-- chat_messages
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON public.chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_id ON public.chat_messages(sender_id);


-- =========================================================================
-- SECURITY HELPER FUNCTIONS (Encapsulates SELECTs to avoid RLS dialogs)
-- =========================================================================

-- Check if user is owner of a room
CREATE OR REPLACE FUNCTION public.is_room_owner(p_room_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.rooms
        WHERE id = p_room_id AND owner_id = p_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user is active member of a room
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.room_members
        WHERE room_id = p_room_id AND user_id = p_user_id AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user has a profile with a specific email
CREATE OR REPLACE FUNCTION public.user_has_email(p_user_id UUID, p_email TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users
        WHERE id = p_user_id AND email = p_email
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user is member of session's room
CREATE OR REPLACE FUNCTION public.is_session_member(p_session_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = p_session_id 
          AND (public.is_room_member(s.room_id, p_user_id) OR public.is_room_owner(s.room_id, p_user_id))
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user is member of thread's session's room
CREATE OR REPLACE FUNCTION public.is_thread_member(p_thread_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.chat_threads t
        WHERE t.id = p_thread_id
          AND (
              t.session_id IS NULL OR
              public.is_session_member(t.session_id, p_user_id)
          )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user can access a draft
CREATE OR REPLACE FUNCTION public.can_access_draft(p_draft_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.drafts d
        WHERE d.id = p_draft_id
          AND (public.is_room_member(d.room_id, p_user_id) OR public.is_room_owner(d.room_id, p_user_id))
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if user can modify a draft
CREATE OR REPLACE FUNCTION public.can_modify_draft(p_draft_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.drafts d
        WHERE d.id = p_draft_id
          AND (d.created_by = p_user_id OR public.is_room_owner(d.room_id, p_user_id))
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================================
-- ROW LEVEL SECURITY (RLS) & POLICIES FOR ALL TABLES
-- =========================================================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_filesystem_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;


-- 1. users policies
CREATE POLICY "Allow authenticated users to read profiles"
ON public.users FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Allow users to update their own profile"
ON public.users FOR UPDATE TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);


-- 2. rooms policies
CREATE POLICY "Allow members and owners to read room details"
ON public.rooms FOR SELECT TO authenticated
USING (owner_id = auth.uid() OR public.is_room_member(id, auth.uid()));

CREATE POLICY "Allow authenticated users to create rooms"
ON public.rooms FOR INSERT TO authenticated
WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Allow owner to update room details"
ON public.rooms FOR UPDATE TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Allow owner to delete room"
ON public.rooms FOR DELETE TO authenticated
USING (owner_id = auth.uid());


-- 3. room_members policies
CREATE POLICY "Allow members and owners to read room membership list"
ON public.room_members FOR SELECT TO authenticated
USING (public.is_room_owner(room_id, auth.uid()) OR public.is_room_member(room_id, auth.uid()));

CREATE POLICY "Allow room owner or self to add room member"
ON public.room_members FOR INSERT TO authenticated
WITH CHECK (public.is_room_owner(room_id, auth.uid()) OR auth.uid() = user_id);

CREATE POLICY "Allow room owner to update membership roles/status"
ON public.room_members FOR UPDATE TO authenticated
USING (public.is_room_owner(room_id, auth.uid()))
WITH CHECK (public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or self to remove membership"
ON public.room_members FOR DELETE TO authenticated
USING (public.is_room_owner(room_id, auth.uid()) OR auth.uid() = user_id);


-- 4. invitations policies
CREATE POLICY "Allow inviter or invitee to read invitations"
ON public.invitations FOR SELECT TO authenticated
USING (inviter_id = auth.uid() OR public.user_has_email(auth.uid(), email));

CREATE POLICY "Allow room owner to send invitations"
ON public.invitations FOR INSERT TO authenticated
WITH CHECK (public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or invitee to update invitation status"
ON public.invitations FOR UPDATE TO authenticated
USING (public.is_room_owner(room_id, auth.uid()) OR public.user_has_email(auth.uid(), email));

CREATE POLICY "Allow room owner to delete invitations"
ON public.invitations FOR DELETE TO authenticated
USING (public.is_room_owner(room_id, auth.uid()));


-- 5. sessions policies
CREATE POLICY "Allow room members to read sessions"
ON public.sessions FOR SELECT TO authenticated
USING (public.is_room_member(room_id, auth.uid()) OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room members to create sessions"
ON public.sessions FOR INSERT TO authenticated
WITH CHECK (public.is_room_member(room_id, auth.uid()) OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to update session"
ON public.sessions FOR UPDATE TO authenticated
USING (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()))
WITH CHECK (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to delete session"
ON public.sessions FOR DELETE TO authenticated
USING (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()));


-- 6. drafts policies
CREATE POLICY "Allow room members to read drafts"
ON public.drafts FOR SELECT TO authenticated
USING (public.is_room_member(room_id, auth.uid()) OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room members to create drafts"
ON public.drafts FOR INSERT TO authenticated
WITH CHECK (public.is_room_member(room_id, auth.uid()) OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to update draft"
ON public.drafts FOR UPDATE TO authenticated
USING (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()))
WITH CHECK (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to delete draft"
ON public.drafts FOR DELETE TO authenticated
USING (created_by = auth.uid() OR public.is_room_owner(room_id, auth.uid()));


-- 7. draft_filesystem_ops policies
CREATE POLICY "Allow room members to read draft filesystem operations"
ON public.draft_filesystem_ops FOR SELECT TO authenticated
USING (public.can_access_draft(draft_id, auth.uid()));

CREATE POLICY "Allow room members to create draft filesystem operations"
ON public.draft_filesystem_ops FOR INSERT TO authenticated
WITH CHECK (public.can_access_draft(draft_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to update draft filesystem operations"
ON public.draft_filesystem_ops FOR UPDATE TO authenticated
USING (public.can_modify_draft(draft_id, auth.uid()))
WITH CHECK (public.can_modify_draft(draft_id, auth.uid()));

CREATE POLICY "Allow room owner or creator to delete draft filesystem operations"
ON public.draft_filesystem_ops FOR DELETE TO authenticated
USING (public.can_modify_draft(draft_id, auth.uid()));


-- 8. chat_threads policies
CREATE POLICY "Allow members of thread's room to read thread"
ON public.chat_threads FOR SELECT TO authenticated
USING (session_id IS NULL OR public.is_session_member(session_id, auth.uid()));

CREATE POLICY "Allow authenticated users to create threads"
ON public.chat_threads FOR INSERT TO authenticated
WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Allow thread creator to update thread"
ON public.chat_threads FOR UPDATE TO authenticated
USING (auth.uid() = created_by)
WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Allow thread creator to delete thread"
ON public.chat_threads FOR DELETE TO authenticated
USING (auth.uid() = created_by);


-- 9. chat_messages policies
CREATE POLICY "Allow members of thread's room to read messages"
ON public.chat_messages FOR SELECT TO authenticated
USING (public.is_thread_member(thread_id, auth.uid()));

CREATE POLICY "Allow members of thread's room to insert messages"
ON public.chat_messages FOR INSERT TO authenticated
WITH CHECK (auth.uid() = sender_id AND public.is_thread_member(thread_id, auth.uid()));

CREATE POLICY "Allow message sender to update their message"
ON public.chat_messages FOR UPDATE TO authenticated
USING (auth.uid() = sender_id)
WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Allow message sender to delete their message"
ON public.chat_messages FOR DELETE TO authenticated
USING (auth.uid() = sender_id);
