import * as vscode from "vscode";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as crypto from "crypto";

import type { Draft } from "@conduit/shared-types";
import { buildRoomKey } from "./sessionKeys.js";
import type { BroadcastHub, CollaboratorPresence } from "./broadcast.js";
import type { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import type { LocalFallbackStore } from "./LocalFallbackStore.js";
import type { AuthService } from "./AuthService.js";

export interface ConnectOptions {
    websocketUrl: string;
    roomId: string;
    branch: string;
    sessionId: string;
    userId: string;
    doc: Y.Doc;
    baseCommitHash?: string;
}

export class ConduitWebSocketClient {
    private ws?: WebSocket;
    private activeSession?: ConnectOptions;
    private awareness?: Awareness;
    private authService?: AuthService;

    private docUpdateListener?: (update: Uint8Array, origin: any) => void;
    private awarenessUpdateListener?: (update: any, origin: any) => void;
    private awarenessChangeListener?: () => void;

    constructor(
        private readonly broadcastHub: BroadcastHub,
        private readonly branchSessionRegistry: BranchSessionRegistry,
        private readonly localFallbackStore: LocalFallbackStore,
        public readonly saveDraftFn: (draft: Draft) => Promise<void>,
        public readonly updateDraftStatusFn: (id: string, status: Draft["status"]) => Promise<void>,
        public readonly listDraftsFn: (options?: any) => Promise<Draft[]>
    ) { }

    setAuthService(auth: AuthService): void {
        this.authService = auth;
    }

    async connect(opts: ConnectOptions): Promise<void> {
        if (this.ws) {
            await this.disconnect();
        }

        this.activeSession = opts;
        const roomKey = buildRoomKey(opts.roomId, opts.branch, opts.sessionId);
        const url = `${opts.websocketUrl.replace(/\/$/, "")}/${roomKey}`;

        this.broadcastHub.publishSnapshot({
            roomId: opts.roomId,
            websocketUrl: opts.websocketUrl,
            state: "connecting",
            participantCount: 0,
            collaborators: [],
        });

        this.broadcastHub.log("info", `Connecting to session ${opts.sessionId} on branch ${opts.branch}...`);

        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(url);
                this.ws = ws;

                const doc = opts.doc;
                const awareness = new Awareness(doc);
                this.awareness = awareness;

                const userState = {
                    user: {
                        id: opts.userId,
                        name: this.authService?.getState().user?.name || `User ${opts.userId.slice(0, 4)}`,
                        color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
                        status: "online",
                    },
                };
                awareness.setLocalState(userState);

                const docUpdateListener = (update: Uint8Array, origin: any) => {
                    if (origin !== this && ws.readyState === WebSocket.OPEN) {
                        const encoder = encoding.createEncoder();
                        encoding.writeVarUint(encoder, 0); // messageSync
                        syncProtocol.writeUpdate(encoder, update);
                        ws.send(encoding.toUint8Array(encoder));
                    }
                };
                doc.on("update", docUpdateListener);
                this.docUpdateListener = docUpdateListener;

                const awarenessUpdateListener = ({ added, updated, removed }: any, origin: any) => {
                    if (origin !== this && ws.readyState === WebSocket.OPEN) {
                        const changedClients = added.concat(updated, removed);
                        const encoder = encoding.createEncoder();
                        encoding.writeVarUint(encoder, 2); // messageAwareness
                        encoding.writeVarUint8Array(
                            encoder,
                            awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
                        );
                        ws.send(encoding.toUint8Array(encoder));
                    }
                };
                awareness.on("update", awarenessUpdateListener);
                this.awarenessUpdateListener = awarenessUpdateListener;

                const awarenessChangeListener = () => {
                    const collaborators: CollaboratorPresence[] = [];
                    awareness.getStates().forEach((state: any, clientID) => {
                        if (state.user) {
                            collaborators.push({
                                userId: state.user.id || String(clientID),
                                name: state.user.name || "Anonymous",
                                color: state.user.color || "#cccccc",
                                status: "online",
                            });
                        }
                    });

                    const current = this.broadcastHub.getSnapshot();
                    this.broadcastHub.publishSnapshot({
                        ...current,
                        state: "connected",
                        participantCount: collaborators.length,
                        collaborators,
                    });
                };
                awareness.on("change", awarenessChangeListener);
                this.awarenessChangeListener = awarenessChangeListener;

                const pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.ping();
                    }
                }, 40000);

                ws.on("open", () => {
                    this.broadcastHub.log("info", "Connected successfully.");
                    this.broadcastHub.publishSnapshot({
                        roomId: opts.roomId,
                        websocketUrl: opts.websocketUrl,
                        state: "connected",
                        participantCount: 1,
                        collaborators: [
                            {
                                userId: opts.userId,
                                name: userState.user.name,
                                color: userState.user.color,
                                status: "online",
                            },
                        ],
                    });

                    this.branchSessionRegistry.save(opts.branch, {
                        roomId: opts.roomId,
                        branch: opts.branch,
                        sessionId: opts.sessionId,
                        websocketUrl: opts.websocketUrl,
                        userId: opts.userId,
                    });

                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, 0); // messageSync
                    syncProtocol.writeSyncStep1(encoder, doc);
                    ws.send(encoding.toUint8Array(encoder));

                    const awarenessEncoder = encoding.createEncoder();
                    encoding.writeVarUint(awarenessEncoder, 1); // messageQueryAwareness
                    ws.send(encoding.toUint8Array(awarenessEncoder));

                    resolve();
                });

                ws.on("message", (data: any) => {
                    try {
                        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                        const uint8Array = new Uint8Array(buf);
                        const decoder = decoding.createDecoder(uint8Array);
                        const messageType = decoding.readVarUint(decoder);

                        if (messageType === 0) { // messageSync
                            const encoder = encoding.createEncoder();
                            encoding.writeVarUint(encoder, 0);
                            syncProtocol.readSyncMessage(decoder, encoder, doc, this);
                            if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
                                ws.send(encoding.toUint8Array(encoder));
                            }
                        } else if (messageType === 1) { // messageQueryAwareness
                            const encoder = encoding.createEncoder();
                            encoding.writeVarUint(encoder, 2); // messageAwareness
                            encoding.writeVarUint8Array(
                                encoder,
                                awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.states.keys()))
                            );
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(encoding.toUint8Array(encoder));
                            }
                        } else if (messageType === 2) { // messageAwareness
                            const update = decoding.readVarUint8Array(decoder);
                            awarenessProtocol.applyAwarenessUpdate(awareness, update, this);
                        }
                    } catch (err: any) {
                        this.broadcastHub.log("error", `Failed to handle message: ${err.message}`);
                    }
                });

                ws.on("error", (err) => {
                    this.broadcastHub.log("error", `WebSocket error: ${err.message}`);
                    this.broadcastHub.publishSnapshot({
                        ...this.broadcastHub.getSnapshot(),
                        state: "error",
                        lastError: err.message,
                    });
                    reject(err);
                });

                ws.on("close", (code, reason) => {
                    clearInterval(pingInterval);
                    this.broadcastHub.log("info", `Connection closed: ${code} - ${reason.toString()}`);
                    this.handleDisconnect(true);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async disconnect(saveDraft = true): Promise<void> {
        if (!this.ws) {
            return;
        }

        const ws = this.ws;
        this.ws = undefined;

        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }

        await this.handleDisconnect(saveDraft);
    }

    async leaveUnexpected(reason: string): Promise<void> {
        this.broadcastHub.log("error", `Leaving session unexpectedly: ${reason}`);
        const snapshot = this.broadcastHub.getSnapshot();
        this.broadcastHub.publishSnapshot({
            ...snapshot,
            state: "error",
            lastError: reason,
        });
        await this.disconnect();
    }

    async recoverLocalFallbacks(): Promise<void> {
        const drafts = this.localFallbackStore.list();
        for (const draft of drafts) {
            try {
                await this.saveDraftFn(draft);
                await this.localFallbackStore.remove(draft.id);
                this.broadcastHub.log("info", `Recovered local fallback draft: ${draft.id}`);
            } catch (error: any) {
                this.broadcastHub.log("error", `Failed to recover local fallback draft ${draft.id}: ${error.message}`);
            }
        }
    }

    async restoreSession(opts: { roomId: string; branch: string; sessionId: string }): Promise<void> {
        const descriptor = this.branchSessionRegistry.get(opts.branch);
        const websocketUrl =
            descriptor?.websocketUrl ||
            vscode.workspace.getConfiguration("conduit").get<string>("websocketUrl") ||
            "ws://localhost:4000";
        const userId = descriptor?.userId || this.authService?.getState().user?.id || "anonymous";

        const doc = new Y.Doc();

        await this.connect({
            websocketUrl,
            roomId: opts.roomId,
            branch: opts.branch,
            sessionId: opts.sessionId,
            userId,
            doc,
            baseCommitHash: descriptor?.roomId === opts.roomId ? descriptor.roomId : "",
        });
    }

    private async handleDisconnect(saveDraft = true): Promise<void> {
        const session = this.activeSession;
        if (!session) {
            return;
        }

        if (this.docUpdateListener) {
            session.doc.off("update", this.docUpdateListener);
            this.docUpdateListener = undefined;
        }
        if (this.awareness) {
            if (this.awarenessUpdateListener) {
                this.awareness.off("update", this.awarenessUpdateListener);
                this.awarenessUpdateListener = undefined;
            }
            if (this.awarenessChangeListener) {
                this.awareness.off("change", this.awarenessChangeListener);
                this.awarenessChangeListener = undefined;
            }
            this.awareness.destroy();
            this.awareness = undefined;
        }

        this.activeSession = undefined;

        if (saveDraft) {
            try {
                const encodedState = Buffer.from(Y.encodeStateAsUpdate(session.doc)).toString("base64");
                const draft: Draft = {
                    id: crypto.randomUUID(),
                    sessionId: session.sessionId,
                    roomId: session.roomId,
                    branch: session.branch,
                    baseCommitHash: session.baseCommitHash || "",
                    yjsState: encodedState,
                    filesystemOps: [],
                    aiEvents: [],
                    createdBy: session.userId,
                    createdAt: new Date().toISOString(),
                    status: "active",
                };

                try {
                    await this.saveDraftFn(draft);
                    this.broadcastHub.log("info", `Session saved as draft: ${draft.id}`);
                } catch (err: any) {
                    this.broadcastHub.log("warn", `Failed to save draft to backend, falling back locally: ${err.message}`);
                    await this.localFallbackStore.save(draft.id, draft);
                }
            } catch (err: any) {
                this.broadcastHub.log("error", `Failed to prepare/save session draft: ${err.message}`);
            }
        }

        this.broadcastHub.publishSnapshot({
            state: "disconnected",
            participantCount: 0,
            collaborators: [],
        });
    }
}
