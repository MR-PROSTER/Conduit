import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";
import { showAccountCommand, signInCommand, signOutCommand } from "./auth.js";
import { createRoomCommand } from "./createRoom.js";
import { createSessionCommand } from "./createSession.js";
import { joinRoomCommand } from "./joinRoom.js";
import { joinSessionCommand } from "./joinSession.js";
import { leaveRoomCommand } from "./leaveRoom.js";
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
    createRoomCommand(services),
    createSessionCommand(services),
    joinRoomCommand(services),
    joinSessionCommand(services),
    leaveRoomCommand(services),
    leaveSessionCommand(services),
    restoreDraftsCommand(services),
    switchBranchCommand(services)
  ];
};
