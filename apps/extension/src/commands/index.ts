import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";
import { showAccountCommand, signInCommand, signOutCommand } from "./auth.js";
import { createSessionCommand } from "./createSession.js";
import { joinSessionCommand } from "./joinSession.js";
import { leaveSessionCommand } from "./leaveSession.js";
import { restoreDraftsCommand } from "./restoreDrafts.js";
import { switchBranchCommand } from "./switchBranch.js";

/**
 * Registers all Conduit extension commands.
 */
export const registerCommands = (
  services: ExtensionServices
): readonly vscode.Disposable[] => {
  return [
    signInCommand(services),
    signOutCommand(services),
    showAccountCommand(services),
    createSessionCommand(services),
    joinSessionCommand(services),
    leaveSessionCommand(services),
    restoreDraftsCommand(services),
    switchBranchCommand(services)
  ];
};
