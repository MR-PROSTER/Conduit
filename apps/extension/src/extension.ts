import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import { AuthService } from "./AuthService.js";
import { BroadcastHub } from "./broadcast.js";
import { registerCommands } from "./commands/index.js";
import { DraftRestoreController } from "./DraftRestoreController.js";
import { LocalFallbackStore } from "./LocalFallbackStore.js";
import { SidebarProvider } from "./SidebarProvider.js";
import { ConduitWebSocketClient } from "./wsClient.js";
import { getStateManager } from "./state/ExtensionStateManager.js";
import { ApiKeyStore } from "./ai/ApiKeyStore.js";
import { ChatPanelProvider } from "./ai/ChatPanelProvider.js";

const execFileAsync = promisify(execFile);

export interface ExtensionServices {
    readonly context: vscode.ExtensionContext;
    readonly branchSessionRegistry: BranchSessionRegistry;
    readonly broadcastHub: BroadcastHub;
    readonly draftRestoreController: DraftRestoreController;
    readonly sidebarProvider: SidebarProvider;
    readonly authService: AuthService;
    readonly wsClient: ConduitWebSocketClient;
    readonly websocketUrl: string;
    readonly localUserId: string;
    readonly localUserName: string;
}

let extensionDisposable: vscode.Disposable | undefined;
let activeWsClient: ConduitWebSocketClient | undefined;

/**
 * Activates the Conduit VS Code extension.
 */
export const activate = async (
    context: vscode.ExtensionContext
): Promise<void> => {
    const broadcastHub = new BroadcastHub();
    const branchSessionRegistry = new BranchSessionRegistry(context);
    const localFallbackStore = new LocalFallbackStore(context);
    const websocketUrl =
        vscode.workspace.getConfiguration("conduit").get<string>("websocketUrl") ??
        "ws://localhost:4000/ws";
    const localUserId = getOrCreateUserId(context);
    let localUserName = "Conduit User";
    try {
        const folders = vscode.workspace.workspaceFolders;
        const firstFolder = folders?.[0];
        const cwd = firstFolder ? firstFolder.uri.fsPath : undefined;
        const { stdout } = await execFileAsync("git", ["config", "user.name"], { cwd });
        const name = stdout.trim();
        if (name) {
            localUserName = name;
            await context.globalState.update("conduit.userName", name);
        } else {
            localUserName = context.globalState.get<string>("conduit.userName") ?? "Conduit User";
        }
    } catch {
        localUserName = context.globalState.get<string>("conduit.userName") ?? "Conduit User";
    }
    const authService = new AuthService(context, websocketUrl);
    const stateManager = getStateManager();
    context.subscriptions.push({
        dispose: () => stateManager.dispose()
    });
    const wsClient = new ConduitWebSocketClient(
        broadcastHub,
        branchSessionRegistry,
        localFallbackStore,
        (draft, accessToken) => authService.saveDraft(draft, accessToken),
        (draftId, status, accessToken) =>
            authService.updateDraftStatus(draftId, status, accessToken),
        (options, accessToken) => authService.listDrafts(options, accessToken)
    );
    activeWsClient = wsClient;
    wsClient.setAuthService(authService);
    const sidebarProvider = new SidebarProvider(
        broadcastHub,
        branchSessionRegistry,
        wsClient,
        websocketUrl,
        authService,
        localUserId,
        localUserName,
        context.extensionUri
    );
    context.subscriptions.push(
        stateManager.onDidChangeState(() => {
            void sidebarProvider.refresh();
        })
    );
    const draftRestoreController = new DraftRestoreController(wsClient);

    const services: ExtensionServices = {
        context,
        branchSessionRegistry,
        broadcastHub,
        draftRestoreController,
        sidebarProvider,
        authService,
        wsClient,
        websocketUrl,
        localUserId,
        localUserName
    };

    const commandDisposables = registerCommands(services);

    // Register commands before any slower startup work so a later failure does
    // not leave the extension looking "unloaded" in the command palette.
    const sidebarRegistration = vscode.window.registerWebviewViewProvider(
        SidebarProvider.viewType,
        sidebarProvider
    );

    // ── Phase 5: AI Panel ──────────────────────────────────────────
    const apiKeyStore = new ApiKeyStore(context);
    const chatPanelProvider = new ChatPanelProvider(
        context,
        broadcastHub,
        authService,
        apiKeyStore,
        wsClient
    );
    const aiPanelRegistration = vscode.window.registerWebviewViewProvider(
        ChatPanelProvider.viewType,
        chatPanelProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );

    extensionDisposable = vscode.Disposable.from(
        broadcastHub,
        wsClient,
        sidebarProvider,
        sidebarRegistration,
        chatPanelProvider,
        aiPanelRegistration,
        ...commandDisposables
    );

    context.subscriptions.push(extensionDisposable);

    void initializeStartup({
        authService,
        broadcastHub,
        branchSessionRegistry,
        draftRestoreController,
        stateManager,
        localUserName,
        websocketUrl,
        wsClient
    }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        broadcastHub.log("error", `Conduit startup failed: ${message}`);
        console.error("[conduit-extension] Startup failed:", error);
    });
};

const initializeStartup = async (services: {
    readonly authService: AuthService;
    readonly broadcastHub: BroadcastHub;
    readonly branchSessionRegistry: BranchSessionRegistry;
    readonly draftRestoreController: DraftRestoreController;
    readonly stateManager: ReturnType<typeof getStateManager>;
    readonly localUserName: string;
    readonly websocketUrl: string;
    readonly wsClient: ConduitWebSocketClient;
}): Promise<void> => {
    try {
        const { authService, broadcastHub, draftRestoreController, stateManager, localUserName, websocketUrl, wsClient } = services;
        await wsClient.recoverLocalFallbacks();
        let auth = await authService.getState();
        if (auth.accessToken && auth.user) {
            stateManager.signIn({
                id: auth.user.id,
                email: auth.user.email ?? "",
                username: auth.user.username ?? ""
            });
            try {
                const user = await authService.refreshMe();
                auth = {
                    accessToken: auth.accessToken,
                    user
                };
            } catch (error) {
                broadcastHub.log(
                    "warn",
                    `Cleared stale Conduit auth session: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
                auth = {
                    accessToken: undefined,
                    user: undefined
                };
            }
        }

        if (auth.accessToken && auth.user) {
            try {
                if (localUserName && localUserName !== "Conduit User") {
                    await authService.updateProfileName(localUserName);
                }
            } catch (err) {
                console.error("Failed to sync profile name on activation:", err);
            }
            const updatedAuth = await authService.getState();
            const finalName = updatedAuth.user?.username ?? localUserName;

            const restored = await wsClient.restoreSession({
                websocketUrl,
                localUserId: auth.user.id,
                localUserName: auth.user.username || auth.user.email || localUserName,
                accessToken: auth.accessToken
            });
            if (restored) {
                const realtimeState = wsClient.getState();
                if (realtimeState.room) {
                    stateManager.setRoom(realtimeState.room);
                }
                if (realtimeState.session) {
                    stateManager.setSession(realtimeState.session);
                }
                broadcastHub.log(
                    "info",
                    "Restored branch-scoped collaborative session"
                );
                if (realtimeState.session) {
                    draftRestoreController.promptToRestoreSessionDrafts(
                        realtimeState.session.id
                    ).then((prompted) => {
                        if (!prompted) {
                            void draftRestoreController.promptToRestoreUnresolvedDrafts();
                        }
                    });
                } else {
                    void draftRestoreController.promptToRestoreUnresolvedDrafts();
                }
            }
        }
    } catch (error) {
        throw error;
    }

    services.broadcastHub.log("info", "Conduit extension activated");
};

/**
 * Deactivates the Conduit VS Code extension.
 */
export const deactivate = async (): Promise<void> => {
    await activeWsClient?.leaveUnexpected("VS Code window closed unexpectedly");
    extensionDisposable?.dispose();
    extensionDisposable = undefined;
    activeWsClient = undefined;
};

const getOrCreateUserId = (context: vscode.ExtensionContext): string => {
    const existingUserId = context.globalState.get<string>("conduit.userId");
    if (existingUserId) {
        return existingUserId;
    }

    const generatedUserId = `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
    void context.globalState.update("conduit.userId", generatedUserId);
    return generatedUserId;
};
