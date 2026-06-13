import { Buffer } from "buffer";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { Draft, FilesystemEvent } from "@conduit/shared-types";
import { getSupabaseClient } from "./supabaseClient.js";

export type DraftRepositoryErrorCode =
  | "DATABASE_NOT_CONFIGURED"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_OWNERSHIP_MISMATCH"
  | "INVALID_STATUS_TRANSITION"
  | "DRAFT_ALREADY_EXISTS"
  | "DATABASE_ERROR";

export class DraftRepositoryError extends Error {
  constructor(
    public code: DraftRepositoryErrorCode,
    message: string,
    public originalError?: any,
  ) {
    super(message);
    this.name = "DraftRepositoryError";
  }
}

export interface CreateDraftInput {
  id?: string;
  sessionId: string;
  roomId: string;
  branch: string;
  baseCommitHash: string;
  yjsState?: string;
  filesystemOps?: readonly FilesystemEvent[];
  aiEvents?: readonly string[];
  createdBy: string;
  ownerId: string;
  lineage?: string;
}

export interface UpdateDraftInput {
  status?: "active" | "applied" | "discarded";
  lineage?: string;
  yjsState?: string;
  filesystemOps?: readonly FilesystemEvent[];
  aiEvents?: readonly string[];
}

export interface DraftQuery {
  roomId?: string;
  branch?: string;
  status?: "active" | "applied" | "discarded";
  sessionId?: string;
}

export interface DraftRecord extends Draft {
  ownerId: string;
  updatedAt: string;
}

export class DraftRepository {
  private supabase: SupabaseClient | undefined;
  private s3Client: S3Client | undefined;
  private r2BucketName = "drafts";

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase;
  }

  async initialize(): Promise<void> {
    if (!this.supabase) {
      this.supabase = getSupabaseClient();
    }

    const r2AccessKey = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const r2SecretKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    const r2Endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
    this.r2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || "drafts";

    if (r2AccessKey && r2SecretKey && r2Endpoint) {
      this.s3Client = new S3Client({
        region: "auto",
        endpoint: r2Endpoint,
        credentials: {
          accessKeyId: r2AccessKey,
          secretAccessKey: r2SecretKey,
        },
      });
      console.log(`[INFO] Cloudflare R2 storage initialized using bucket: ${this.r2BucketName}`);
    }

    if (this.supabase) {
      // Run migrations on initialize
      try {
        const { runMigrations } = await import("./migration.js");
        await runMigrations(this.supabase);
      } catch (err) {
        console.error("Failed to run migrations during DraftRepository initialization:", err);
      }

      // Ensure drafts storage bucket exists
      if (!this.s3Client) {
        try {
          await this.ensureBucketExists();
        } catch (err) {
          console.error("Failed to check/create drafts storage bucket:", err);
        }
      }
    }
  }

  private async uploadStorageFile(key: string, base64Data: string): Promise<void> {
    const buffer = Buffer.from(base64Data, "base64");
    if (this.s3Client) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.r2BucketName,
          Key: key,
          Body: buffer,
          ContentType: "application/octet-stream",
        }),
      );
    } else {
      const supabase = this.checkConfig();
      const { error: uploadError } = await supabase.storage.from("drafts").upload(key, buffer, {
        contentType: "application/octet-stream",
        upsert: true,
      });

      if (uploadError) {
        throw uploadError;
      }
    }
  }

  private async downloadStorageFile(key: string): Promise<string> {
    if (this.s3Client) {
      try {
        const response = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: this.r2BucketName,
            Key: key,
          }),
        );
        if (response.Body) {
          const byteArray = await response.Body.transformToByteArray();
          return Buffer.from(byteArray).toString("base64");
        }
        return "";
      } catch (err: any) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return "";
        }
        throw err;
      }
    } else {
      const supabase = this.checkConfig();
      const { data: blob, error: downloadError } = await supabase.storage
        .from("drafts")
        .download(key);

      if (downloadError) {
        if (
          downloadError.message.includes("Object not found") ||
          (downloadError as any).status === 404
        ) {
          return "";
        }
        throw downloadError;
      }
      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        return Buffer.from(arrayBuffer).toString("base64");
      }
      return "";
    }
  }

  private async deleteStorageFile(key: string): Promise<void> {
    if (this.s3Client) {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.r2BucketName,
          Key: key,
        }),
      );
    } else {
      const supabase = this.checkConfig();
      const { error } = await supabase.storage.from("drafts").remove([key]);
      if (error) throw error;
    }
  }

  private async deleteStorageFiles(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (this.s3Client) {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.r2BucketName,
          Delete: {
            Objects: keys.map((k) => ({ Key: k })),
          },
        }),
      );
    } else {
      const supabase = this.checkConfig();
      const { error } = await supabase.storage.from("drafts").remove(keys);
      if (error) throw error;
    }
  }

  isConfigured(): boolean {
    return !!this.supabase;
  }

  private checkConfig(): SupabaseClient {
    if (!this.supabase) {
      throw new DraftRepositoryError(
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured. Did you call initialize()?",
      );
    }
    return this.supabase;
  }

  private async ensureBucketExists(): Promise<void> {
    if (this.s3Client) {
      return;
    }
    const supabase = this.checkConfig();
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      if (listError) {
        // List bucket error, try to create it anyway
      } else if (buckets && buckets.some((b) => b.name === "drafts")) {
        return;
      }
      await supabase.storage.createBucket("drafts", {
        public: false,
      });
    } catch {
      // Suppress bucket creation check errors in tests/environments where storage might be disabled
    }
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRecord> {
    const supabase = this.checkConfig();
    const id = input.id || crypto.randomUUID();
    const storageKey = `${id}.yjs`;

    // 1. Check if draft already exists
    const { data: existing, error: existError } = await supabase
      .from("drafts")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (existError) {
      throw new DraftRepositoryError("DATABASE_ERROR", existError.message, existError);
    }
    if (existing) {
      throw new DraftRepositoryError("DRAFT_ALREADY_EXISTS", `Draft with ID ${id} already exists`);
    }

    // 2. Upload Yjs binary to storage bucket if yjsState is provided
    if (input.yjsState) {
      try {
        await this.uploadStorageFile(storageKey, input.yjsState);
      } catch (err: any) {
        throw new DraftRepositoryError(
          "DATABASE_ERROR",
          `Failed to upload Yjs state to storage: ${err.message}`,
          err,
        );
      }
    }

    // 3. Insert metadata into drafts table
    const { data: draftData, error: insertError } = await supabase
      .from("drafts")
      .insert({
        id,
        session_id: input.sessionId,
        room_id: input.roomId,
        branch: input.branch,
        base_commit_hash: input.baseCommitHash,
        owner_id: input.ownerId,
        created_by: input.createdBy,
        storage_key: storageKey,
        status: "active",
        lineage: input.lineage || null,
        ai_events: input.aiEvents || [],
      })
      .select()
      .single();

    if (insertError) {
      // Clean up uploaded file if DB insert fails
      if (input.yjsState) {
        try {
          await this.deleteStorageFile(storageKey);
        } catch (err) {
          console.error("Failed to clean up storage file on metadata insert error:", err);
        }
      }
      throw new DraftRepositoryError(
        "DATABASE_ERROR",
        `Failed to insert draft metadata: ${insertError.message}`,
        insertError,
      );
    }

    // 4. Insert filesystem ops
    if (input.filesystemOps && input.filesystemOps.length > 0) {
      const ops = input.filesystemOps.map((op, index) => ({
        draft_id: id,
        op_index: index,
        op,
      }));

      const { error: opsError } = await supabase.from("draft_filesystem_ops").insert(ops);

      if (opsError) {
        // Clean up draft and file if DB insert of ops fails
        await supabase.from("drafts").delete().eq("id", id);
        if (input.yjsState) {
          await supabase.storage.from("drafts").remove([storageKey]);
        }
        throw new DraftRepositoryError(
          "DATABASE_ERROR",
          `Failed to save draft filesystem operations: ${opsError.message}`,
          opsError,
        );
      }
    }

    return {
      id: draftData.id,
      sessionId: draftData.session_id,
      roomId: draftData.room_id,
      branch: draftData.branch,
      baseCommitHash: draftData.base_commit_hash,
      yjsState: input.yjsState || "",
      filesystemOps: input.filesystemOps || [],
      aiEvents: draftData.ai_events || [],
      createdBy: draftData.created_by,
      createdAt: draftData.created_at,
      status: draftData.status,
      lineage: draftData.lineage || undefined,
      ownerId: draftData.owner_id,
      updatedAt: draftData.updated_at,
    };
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const supabase = this.checkConfig();

    // 1. Fetch metadata
    const { data: draftData, error: draftError } = await supabase
      .from("drafts")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (draftError) {
      throw new DraftRepositoryError("DATABASE_ERROR", draftError.message, draftError);
    }
    if (!draftData) {
      throw new DraftRepositoryError("DRAFT_NOT_FOUND", `Draft with ID ${id} not found`);
    }

    // 2. Fetch filesystem operations
    const { data: opsData, error: opsError } = await supabase
      .from("draft_filesystem_ops")
      .select("op")
      .eq("draft_id", id)
      .order("op_index", { ascending: true });

    if (opsError) {
      throw new DraftRepositoryError("DATABASE_ERROR", opsError.message, opsError);
    }
    const filesystemOps: FilesystemEvent[] = (opsData || []).map((row: any) => row.op);

    // 3. Download Yjs binary state
    let yjsState = "";
    const storageKey = draftData.storage_key || `${id}.yjs`;
    try {
      yjsState = await this.downloadStorageFile(storageKey);
    } catch (err: any) {
      throw new DraftRepositoryError(
        "DATABASE_ERROR",
        `Failed to download Yjs state: ${err.message}`,
        err,
      );
    }

    return {
      id: draftData.id,
      sessionId: draftData.session_id,
      roomId: draftData.room_id,
      branch: draftData.branch,
      baseCommitHash: draftData.base_commit_hash,
      yjsState,
      filesystemOps,
      aiEvents: draftData.ai_events || [],
      createdBy: draftData.created_by,
      createdAt: draftData.created_at,
      status: draftData.status,
      lineage: draftData.lineage || undefined,
      ownerId: draftData.owner_id,
      updatedAt: draftData.updated_at,
    };
  }

  async listDrafts(query: DraftQuery): Promise<DraftRecord[]> {
    const supabase = this.checkConfig();

    let dbQuery = supabase.from("drafts").select("*");
    if (query.roomId) {
      dbQuery = dbQuery.eq("room_id", query.roomId);
    }
    if (query.branch) {
      dbQuery = dbQuery.eq("branch", query.branch);
    }
    if (query.status) {
      dbQuery = dbQuery.eq("status", query.status);
    }
    if (query.sessionId) {
      dbQuery = dbQuery.eq("session_id", query.sessionId);
    }

    const { data: draftsData, error: listError } = await dbQuery.order("updated_at", {
      ascending: false,
    });
    if (listError) {
      throw new DraftRepositoryError("DATABASE_ERROR", listError.message, listError);
    }

    // Return with empty/lazy values for binary/heavy arrays in list view to optimize bandwidth
    return (draftsData || []).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      roomId: row.room_id,
      branch: row.branch,
      baseCommitHash: row.base_commit_hash,
      yjsState: "",
      filesystemOps: [],
      aiEvents: row.ai_events || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      status: row.status,
      lineage: row.lineage || undefined,
      ownerId: row.owner_id,
      updatedAt: row.updated_at,
    }));
  }

  async updateDraft(id: string, input: UpdateDraftInput): Promise<DraftRecord> {
    const supabase = this.checkConfig();

    // 1. Check if draft exists
    const { data: existing, error: getError } = await supabase
      .from("drafts")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (getError) {
      throw new DraftRepositoryError("DATABASE_ERROR", getError.message, getError);
    }
    if (!existing) {
      throw new DraftRepositoryError("DRAFT_NOT_FOUND", `Draft with ID ${id} not found`);
    }

    // 2. Validate invalid status transitions
    if (input.status && existing.status !== input.status) {
      if (existing.status === "applied" || existing.status === "discarded") {
        throw new DraftRepositoryError(
          "INVALID_STATUS_TRANSITION",
          `Cannot transition draft from status '${existing.status}' to '${input.status}'`,
        );
      }
    }

    // 3. Update table metadata
    const updateData: any = {
      updated_at: new Date().toISOString(),
    };
    if (input.status) {
      updateData.status = input.status;
    }
    if (input.lineage !== undefined) {
      updateData.lineage = input.lineage;
    }
    if (input.aiEvents !== undefined) {
      updateData.ai_events = input.aiEvents;
    }

    const { error: updateError } = await supabase.from("drafts").update(updateData).eq("id", id);

    if (updateError) {
      throw new DraftRepositoryError(
        "DATABASE_ERROR",
        `Failed to update draft metadata: ${updateError.message}`,
        updateError,
      );
    }

    // 4. Update Yjs binary in storage bucket if provided
    if (input.yjsState !== undefined) {
      try {
        const storageKey = existing.storage_key || `${id}.yjs`;
        await this.uploadStorageFile(storageKey, input.yjsState);
      } catch (err: any) {
        throw new DraftRepositoryError(
          "DATABASE_ERROR",
          `Failed to upload Yjs state: ${err.message}`,
          err,
        );
      }
    }

    // 5. Update filesystem ops if provided
    if (input.filesystemOps !== undefined) {
      // Delete existing ops
      const { error: deleteOpsError } = await supabase
        .from("draft_filesystem_ops")
        .delete()
        .eq("draft_id", id);

      if (deleteOpsError) {
        throw new DraftRepositoryError(
          "DATABASE_ERROR",
          `Failed to clear old filesystem ops: ${deleteOpsError.message}`,
          deleteOpsError,
        );
      }

      // Insert new ops
      if (input.filesystemOps.length > 0) {
        const ops = input.filesystemOps.map((op, index) => ({
          draft_id: id,
          op_index: index,
          op,
        }));

        const { error: opsError } = await supabase.from("draft_filesystem_ops").insert(ops);

        if (opsError) {
          throw new DraftRepositoryError(
            "DATABASE_ERROR",
            `Failed to write new filesystem ops: ${opsError.message}`,
            opsError,
          );
        }
      }
    }

    return await this.getDraft(id);
  }

  async deleteDraft(id: string): Promise<void> {
    const supabase = this.checkConfig();

    // 1. Check if draft exists
    const { data: existing, error: getError } = await supabase
      .from("drafts")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (getError) {
      throw new DraftRepositoryError("DATABASE_ERROR", getError.message, getError);
    }
    if (!existing) {
      throw new DraftRepositoryError("DRAFT_NOT_FOUND", `Draft with ID ${id} not found`);
    }

    // 2. Remove binary from storage bucket
    const storageKey = existing.storage_key || `${id}.yjs`;
    try {
      await this.deleteStorageFile(storageKey);
    } catch (err) {
      console.error("Failed to delete storage file:", err);
    }

    // 3. Delete metadata record (draft_filesystem_ops cascade deletes)
    const { error: deleteError } = await supabase.from("drafts").delete().eq("id", id);

    if (deleteError) {
      throw new DraftRepositoryError(
        "DATABASE_ERROR",
        `Failed to delete draft: ${deleteError.message}`,
        deleteError,
      );
    }
  }

  async cleanupExpiredDrafts(daysOld: number): Promise<void> {
    const supabase = this.checkConfig();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    // Fetch drafts matching expiration cutoff
    const { data: expiredDrafts, error: fetchError } = await supabase
      .from("drafts")
      .select("id, storage_key")
      .lt("updated_at", cutoffDate.toISOString());

    if (fetchError) {
      throw new DraftRepositoryError(
        "DATABASE_ERROR",
        `Failed to fetch expired drafts: ${fetchError.message}`,
        fetchError,
      );
    }

    if (expiredDrafts && expiredDrafts.length > 0) {
      const ids = expiredDrafts.map((d) => d.id);
      const fileNames = expiredDrafts.map((d) => d.storage_key || `${d.id}.yjs`);

      // Remove storage files
      try {
        await this.deleteStorageFiles(fileNames);
      } catch (err) {
        console.error("Failed to clean up expired storage files:", err);
      }

      // Delete table records
      const { error: deleteError } = await supabase.from("drafts").delete().in("id", ids);

      if (deleteError) {
        throw new DraftRepositoryError(
          "DATABASE_ERROR",
          `Failed to delete expired drafts: ${deleteError.message}`,
          deleteError,
        );
      }
    }
  }

  async close(): Promise<void> {
    this.supabase = undefined;
  }
}
