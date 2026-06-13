import { Router, Request, Response, NextFunction } from 'express';
import { ChatRepository } from './chatRepository.js';
import { RoomPermissionService } from './permissions.js';
import { getSupabaseClient } from './supabaseClient.js';
import { sendError } from './authRoutes.js';

export function createChatRouter(repo: ChatRepository, authenticator?: any): Router {
  const router = Router();

  // Helper to obtain the RoomPermissionService for auth and room checks
  const getPermissionService = (): RoomPermissionService => {
    if (authenticator && authenticator instanceof RoomPermissionService) {
      return authenticator;
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    return new RoomPermissionService(supabase);
  };

  // Authentication Middleware
  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const service = getPermissionService();
      const user = await service.authenticate(authHeader);
      (req as any).user = user;
      next();
    } catch (error) {
      sendError(res, error);
    }
  };

  // Apply authentication middleware to all chat routes
  router.use(requireAuth);

  // POST /chat/threads → create thread
  router.post('/chat/threads', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { sessionId, type, name, forkedFromMessageId } = req.body;
      const service = getPermissionService();

      // If session is provided, verify room permission first
      if (sessionId) {
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error('Supabase client not initialized');

        const { data: sessionData, error: sessionError } = await supabase
          .from('sessions')
          .select('room_id')
          .eq('id', sessionId)
          .maybeSingle();

        if (sessionError || !sessionData) {
          return res.status(404).json({ error: 'Session not found' });
        }

        await service.assertActiveRoomAccess(user.id, sessionData.room_id);
      }

      const thread = await repo.createThread({
        sessionId,
        type,
        name,
        forkedFromMessageId,
        createdBy: user.id
      });

      res.status(201).json({ thread });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /chat/threads?sessionId=... → list threads
  router.get('/chat/threads', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { sessionId } = req.query as any;

      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query parameter is required' });
      }

      const service = getPermissionService();
      const supabase = getSupabaseClient();
      if (!supabase) throw new Error('Supabase client not initialized');

      // Verify user has access to the session
      const { data: sessionData, error: sessionError } = await supabase
        .from('sessions')
        .select('room_id')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError || !sessionData) {
        return res.status(404).json({ error: 'Session not found' });
      }

      await service.assertActiveRoomAccess(user.id, sessionData.room_id);

      const threads = await repo.listThreads({ sessionId });
      res.json({ threads });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /chat/threads/:id/messages?cursor=... → paginated messages
  router.get('/chat/threads/:id/messages', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const threadId = req.params.id as string;
      const cursor = req.query.cursor as string | undefined;

      const supabase = getSupabaseClient();
      if (!supabase) throw new Error('Supabase client not initialized');

      // Check access permission via Postgres RPC function `is_thread_member`
      const { data: isMember, error: accessError } = await supabase
        .rpc('is_thread_member', { p_thread_id: threadId, p_user_id: user.id });

      if (accessError || !isMember) {
        return res.status(403).json({ error: 'You do not have access to this chat thread' });
      }

      const result = await repo.getMessages(threadId, { cursor, limit: 50 });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /chat/threads/:id/messages → append message
  router.post('/chat/threads/:id/messages', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const threadId = req.params.id as string;
      const supabase = getSupabaseClient();
      if (!supabase) throw new Error('Supabase client not initialized');

      // Check access permission via Postgres RPC function `is_thread_member`
      const { data: isMember, error: accessError } = await supabase
        .rpc('is_thread_member', { p_thread_id: threadId, p_user_id: user.id });

      if (accessError || !isMember) {
        return res.status(403).json({ error: 'You do not have access to this chat thread' });
      }

      const {
        role,
        content,
        model,
        tokensUsed,
        contextRefs,
        agentSteps,
        attachments,
        fileDiffs,
        safetyBlock
      } = req.body;

      if (!role) {
        return res.status(400).json({ error: 'role is required' });
      }

      const message = await repo.appendMessage({
        threadId,
        role,
        content: content || '',
        model,
        tokensUsed,
        contextRefs,
        agentSteps,
        attachments,
        fileDiffs,
        safetyBlock,
        senderId: user.id
      });

      res.status(201).json({ message });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
