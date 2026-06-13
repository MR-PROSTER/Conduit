import * as vscode from "vscode";
import type { AuthService } from "../AuthService.js";
import type { BroadcastHub } from "../broadcast.js";
import type { ConduitWebSocketClient } from "../wsClient.js";
import type { BranchSessionRegistry } from "../BranchSessionRegistry.js";
import type { LocalFallbackStore } from "../LocalFallbackStore.js";
import type { DraftRestoreController } from "../DraftRestoreController.js";
import type { IGitService } from "@conduit/git-core";
import type { SessionManager } from "../SessionManager.js";

import { signInCommand, signOutCommand, showAccountCommand } from "./auth.js";
import { createSessionCommand } from "./createSession.js";
import { joinSessionCommand } from "./joinSession.js";
import { leaveSessionCommand } from "./leaveSession.js";
import { restoreDraftsCommand } from "./restoreDrafts.js";
import { switchBranchCommand } from "./switchBranch.js";

export interface ExtensionServices {
  authService: AuthService;
  broadcastHub: BroadcastHub;
  wsClient: ConduitWebSocketClient;
  branchSessionRegistry: BranchSessionRegistry;
  localFallbackStore: LocalFallbackStore;
  draftRestoreController: DraftRestoreController;
  gitService: IGitService;
  sessionManager: SessionManager;
}

export function registerCommands(services: ExtensionServices): readonly vscode.Disposable[] {
  return [
    signInCommand(services),
    signOutCommand(services),
    showAccountCommand(services),
    createSessionCommand(services),
    joinSessionCommand(services),
    leaveSessionCommand(services),
    restoreDraftsCommand(services),
    switchBranchCommand(services),
  ];
}
