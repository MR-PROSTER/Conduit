import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Y from "yjs";
import { BroadcastHub } from "./broadcast.js";
import { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import { LocalFallbackStore } from "./LocalFallbackStore.js";
import { AuthService } from "./AuthService.js";
import { ConduitWebSocketClient } from "./wsClient.js";
import { SidebarProvider } from "./SidebarProvider.js";
import { DraftRestoreController } from "./DraftRestoreController.js";
import { ApiKeyStore } from "./ai/ApiKeyStore.js";
import { ChatPanelProvider } from "./ai/ChatPanelProvider.js";
import { registerCommands } from "./commands/index.js";
import { SessionManager } from "./SessionManager.js";
import { GitService } from "@conduit/git-core";

const execFileAsync = promisify(execFile);

export interface ExtensionServices {
  context: vscode.ExtensionContext;
  branchSessionRegistry: BranchSessionRegistry;
  broadcastHub: BroadcastHub;
  draftRestoreController: DraftRestoreController;
  sidebarProvider: SidebarProvider;
  authService: AuthService;
  wsClient: ConduitWebSocketClient;
  websocketUrl: string;
  localUserId: string;
  localUserName: string;
}

let extensionDisposable: vscode.Disposable | undefined;
let activeWsClient: ConduitWebSocketClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionServices> {
  const broadcastHub = new BroadcastHub();
  const branchSessionRegistry = new BranchSessionRegistry(context);
  const localFallbackStore = new LocalFallbackStore(context);
  const workspaceRoot = getWorkspaceRoot();

  const websocketUrl =
    vscode.workspace.getConfiguration("conduit").get<string>("websocketUrl") ?? "ws://localhost:4000/ws";
  const localUserId = await getOrCreateUserId(context);
  const localUserName = await getOrCreateUserName(context, workspaceRoot);

  const authService = new AuthService(context);
  const gitService = new GitService(workspaceRoot);
  const wsClient = new ConduitWebSocketClient(
    broadcastHub,
    branchSessionRegistry,
    localFallbackStore,
    async (draft) => {
      const token = authService.getState().accessToken;
      if (!token) {
        throw new Error("You must be signed in to save a draft.");
      }
      await authService.saveDraft(draft, token);
    },
    async (id, status) => {
      const token = authService.getState().accessToken;
      if (!token) {
        throw new Error("You must be signed in to update a draft.");
      }
      await authService.updateDraftStatus(id, status, token);
    },
    async (options) => {
      const token = authService.getState().accessToken;
      if (!token) {
        throw new Error("You must be signed in to list drafts.");
      }
      return authService.listDrafts(options, token);
    }
  );
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
  const draftRestoreController = new DraftRestoreController(wsClient);
  const apiKeyStore = new ApiKeyStore(context);
  const chatPanelProvider = new ChatPanelProvider(context, broadcastHub, authService, apiKeyStore, wsClient);
  const sessionManager = new SessionManager(wsClient, gitService, branchSessionRegistry, authService);

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
    localUserName,
  };

  activeWsClient = wsClient;

  const disposables: vscode.Disposable[] = [
    broadcastHub,
    sessionManager,
    sidebarProvider,
    chatPanelProvider,
    vscode.window.registerWebviewViewProvider("conduit.aiPanel", chatPanelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("conduit.sidebar", sidebarProvider),
    ...registerCommands({
      authService,
      broadcastHub,
      wsClient,
      branchSessionRegistry,
      localFallbackStore,
      draftRestoreController,
      gitService,
      sessionManager,
    }),
  ];

  extensionDisposable = vscode.Disposable.from(...disposables);
  context.subscriptions.push(extensionDisposable);

  await wsClient.recoverLocalFallbacks();

  const authState = authService.getState();
  if (authState.accessToken && authState.user) {
    try {
      const refreshed = await authService.refreshMe();
      if (refreshed?.name !== localUserName) {
        try {
          await authService.updateProfileName(localUserName);
        } catch (error: any) {
          broadcastHub.log("warn", `Failed to sync profile name: ${error.message}`);
        }
      }
    } catch (error: any) {
      broadcastHub.log("warn", `Auth refresh failed, clearing stale state: ${error.message}`);
      await authService.signOut();
    }
  }

  const currentState = authService.getState();
  if (currentState.accessToken && currentState.user) {
    try {
      const currentBranch = await gitService.getCurrentBranch();
      const descriptor = branchSessionRegistry.get(currentBranch.branch);
      if (descriptor) {
        await wsClient.restoreSession({
          roomId: descriptor.roomId,
          branch: descriptor.branch,
          sessionId: descriptor.sessionId,
        });
      }
    } catch (error: any) {
      broadcastHub.log("warn", `Failed to restore saved session: ${error.message}`);
    }

    await draftRestoreController.promptToRestoreUnresolvedDrafts();
  }

  broadcastHub.log("info", "Conduit extension activated");
  return services;
}

export async function deactivate(): Promise<void> {
  try {
    await activeWsClient?.leaveUnexpected("VS Code window closed unexpectedly");
  } finally {
    extensionDisposable?.dispose();
    extensionDisposable = undefined;
    activeWsClient = undefined;
  }
}

async function getOrCreateUserId(context: vscode.ExtensionContext): Promise<string> {
  const key = "conduit:localUserId";
  const stored = context.globalState.get<string>(key);
  if (stored) {
    return stored;
  }

  const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await context.globalState.update(key, generated);
  return generated;
}

async function getOrCreateUserName(context: vscode.ExtensionContext, workspaceRoot: string): Promise<string> {
  const key = "conduit:localUserName";
  const stored = context.globalState.get<string>(key);
  if (stored) {
    return stored;
  }

  try {
    const result = await execFileAsync("git", ["config", "user.name"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const configured = String(result.stdout || "").trim();
    if (configured) {
      await context.globalState.update(key, configured);
      return configured;
    }
  } catch {
    // Fall through to persisted or default values.
  }

  const fallback = context.globalState.get<string>(key) || "Conduit User";
  await context.globalState.update(key, fallback);
  return fallback;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
