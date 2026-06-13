import { Router, Request, Response, NextFunction } from 'express';
import { DraftRepository, DraftQuery } from './draftRepository.js';
import { RoomPermissionService } from './permissions.js';
import { getSupabaseClient } from './supabaseClient.js';
import { sendError } from './authRoutes.js';

export function createDraftRouter(
  repo: DraftRepository,
  authenticator?: any,
  permissions?: RoomPermissionService
): Router {
  const router = Router();

  // Helper to obtain the RoomPermissionService for auth and room checks
  const getPermissionService = (): RoomPermissionService => {
    if (permissions) return permissions;
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

  // Apply authentication middleware to all draft routes
  router.use(requireAuth);

  // POST /drafts (auth) → create draft, 201 { draft }
  router.post('/drafts', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const {
        sessionId,
        roomId,
        branch,
        baseCommitHash,
        yjsState,
        filesystemOps,
        aiEvents,
        lineage,
        ownerId
      } = req.body;

      const service = getPermissionService();

      // Ensure user has access to this room
      await service.assertActiveRoomAccess(user.id, roomId);

      const draft = await repo.createDraft({
        sessionId,
        roomId,
        branch,
        baseCommitHash,
        yjsState,
        filesystemOps,
        aiEvents,
        createdBy: user.id,
        ownerId: ownerId || user.id,
        lineage
      });

      res.status(201).json({ draft });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /drafts (auth) → list drafts by query params (roomId, branch, status, sessionId)
  router.get('/drafts', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { roomId, branch, status, sessionId } = req.query as any;
      const service = getPermissionService();

      // If filtering by room, verify the user's active access to it
      if (roomId) {
        await service.assertActiveRoomAccess(user.id, roomId);
      }

      const query: DraftQuery = {
        roomId,
        branch,
        status,
        sessionId
      };

      const drafts = await repo.listDrafts(query);
      res.json({ drafts });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /drafts/:id (auth) → single draft with yjsState
  router.get('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const draftId = req.params.id as string;
      const service = getPermissionService();

      const draft = await repo.getDraft(draftId);

      // Verify the user has access to the draft's room
      await service.assertActiveRoomAccess(user.id, draft.roomId);

      res.json({ draft });
    } catch (error) {
      sendError(res, error);
    }
  });

  // PATCH /drafts/:id (auth) → update status/lineage
  router.patch('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const draftId = req.params.id as string;
      const { status, lineage, yjsState, filesystemOps, aiEvents } = req.body;
      const service = getPermissionService();

      // Retrieve existing draft to perform room membership checks
      const draft = await repo.getDraft(draftId);
      await service.assertActiveRoomAccess(user.id, draft.roomId);

      const updated = await repo.updateDraft(draftId, {
        status,
        lineage,
        yjsState,
        filesystemOps,
        aiEvents
      });

      res.json({ draft: updated });
    } catch (error) {
      sendError(res, error);
    }
  });

  // DELETE /drafts/:id (auth, owner only) → delete
  router.delete('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const draftId = req.params.id as string;
      const service = getPermissionService();

      const draft = await repo.getDraft(draftId);

      // Verify the user is the room owner or the creator of the draft
      const access = await service.assertActiveRoomAccess(user.id, draft.roomId);
      const isCreator = draft.createdBy === user.id;
      const isRoomOwner = access.isOwner;

      if (!isCreator && !isRoomOwner) {
        return res.status(403).json({ error: 'Only the draft creator or room owner can delete this draft' });
      }

      await repo.deleteDraft(draftId);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
