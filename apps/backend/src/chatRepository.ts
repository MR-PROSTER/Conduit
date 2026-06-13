import { SupabaseClient } from '@supabase/supabase-js';
import type { ChatThread, ChatMessage, AttachmentMeta, ContextRef, AgentStep, FileDiff, SafetyBlock } from '@codesync/shared-types';
import { getSupabaseClient } from './supabaseClient.js';

export interface CreateThreadInput {
  sessionId?: string;
  type?: 'group' | 'private-fork' | 'public-fork' | 'standalone';
  name?: string;
  forkedFromMessageId?: string;
  createdBy: string;
}

export interface AppendMessageInput {
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'agent';
  content: string;
  model?: string;
  tokensUsed?: number;
  contextRefs?: readonly ContextRef[];
  agentSteps?: readonly AgentStep[];
  attachments?: readonly AttachmentMeta[];
  fileDiffs?: readonly FileDiff[];
  safetyBlock?: SafetyBlock;
  senderId?: string;
}

export interface GetMessagesOptions {
  cursor?: string;
  limit?: number;
}

export class ChatRepository {
  private supabase: SupabaseClient | undefined;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase;
  }

  async initialize(): Promise<void> {
    if (!this.supabase) {
      this.supabase = getSupabaseClient();
    }
    if (this.supabase) {
      try {
        const { runMigrations } = await import('./migration.js');
        await runMigrations(this.supabase);
      } catch (err) {
        console.error('Failed to run migrations during ChatRepository initialization:', err);
      }
    }
  }

  isConfigured(): boolean {
    return !!this.supabase;
  }

  private checkConfig(): SupabaseClient {
    if (!this.supabase) {
      throw new Error('Database is not configured. Did you call initialize()?');
    }
    return this.supabase;
  }

  private mapThread(row: any): ChatThread {
    return {
      id: row.id,
      sessionId: row.session_id || undefined,
      type: row.type,
      name: row.name || undefined,
      forkedFromMessageId: row.forked_from_message_id || undefined,
      createdBy: row.created_by,
      createdAt: row.created_at
    };
  }

  private mapMessage(row: any): ChatMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      createdBy: row.sender_id || '',
      createdAt: row.created_at,
      role: row.role,
      content: row.content || '',
      attachments: row.attachments || undefined,
      contextRefs: row.context_refs || undefined,
      agentSteps: row.agent_steps || undefined,
      fileDiffs: row.file_diffs || undefined,
      safetyBlock: row.safety_block || undefined
    };
  }

  async createThread(input: CreateThreadInput): Promise<ChatThread> {
    const supabase = this.checkConfig();

    const { data, error } = await supabase
      .from('chat_threads')
      .insert({
        session_id: input.sessionId || null,
        type: input.type || 'standalone',
        name: input.name || null,
        forked_from_message_id: input.forkedFromMessageId || null,
        created_by: input.createdBy
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapThread(data);
  }

  async getThread(id: string): Promise<ChatThread | null> {
    const supabase = this.checkConfig();

    const { data, error } = await supabase
      .from('chat_threads')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return this.mapThread(data);
  }

  async listThreads(query: { sessionId?: string; createdBy?: string }): Promise<ChatThread[]> {
    const supabase = this.checkConfig();

    let dbQuery = supabase.from('chat_threads').select('*');
    if (query.sessionId) {
      dbQuery = dbQuery.eq('session_id', query.sessionId);
    }
    if (query.createdBy) {
      dbQuery = dbQuery.eq('created_by', query.createdBy);
    }

    const { data, error } = await dbQuery.order('created_at', { ascending: false });
    if (error) throw error;

    return (data || []).map(row => this.mapThread(row));
  }

  async appendMessage(input: AppendMessageInput): Promise<ChatMessage> {
    const supabase = this.checkConfig();

    const { data, error } = await supabase
      .from('chat_messages')
      .insert({
        thread_id: input.threadId,
        role: input.role,
        content: input.content || '',
        model: input.model || null,
        tokens_used: input.tokensUsed || null,
        context_refs: input.contextRefs || null,
        agent_steps: input.agentSteps || null,
        attachments: input.attachments || null,
        file_diffs: input.fileDiffs || null,
        safety_block: input.safetyBlock || null,
        sender_id: input.senderId || null
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapMessage(data);
  }

  async getMessages(
    threadId: string,
    options?: GetMessagesOptions
  ): Promise<{ messages: ChatMessage[]; nextCursor?: string }> {
    const supabase = this.checkConfig();
    const limit = options?.limit || 50;

    let dbQuery = supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (options?.cursor) {
      dbQuery = dbQuery.lt('created_at', options.cursor);
    }

    const { data, error } = await dbQuery;
    if (error) throw error;

    const hasMore = data && data.length > limit;
    const messagesData = hasMore ? data.slice(0, limit) : (data || []);

    const messages = messagesData.map(row => this.mapMessage(row));

    let nextCursor: string | undefined = undefined;
    if (hasMore && messagesData.length > 0) {
      nextCursor = messagesData[messagesData.length - 1].created_at;
    }

    return {
      messages,
      nextCursor
    };
  }
}
