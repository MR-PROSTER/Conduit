import type { ConduitState } from "./ExtensionStateManager.js";

export interface ButtonDef {
  id: string;
  label: string;
  primary: boolean;
  visible: boolean;
  disabled: boolean;
}

export function getButtons(state: ConduitState): ButtonDef[] {
  switch (state) {
    case "SIGNED_OUT":
      return [
        button("signIn", "Sign In", true),
        button("refresh", "Refresh", false),
      ];
    case "SIGNED_IN_NO_ROOM":
      return [
        button("createRoom", "Create Room", true),
        button("joinRoom", "Join Room", false),
        button("signOut", "Sign Out", false),
        button("account", "Account", false),
        button("refresh", "Refresh", false),
      ];
    case "IN_ROOM_NO_SESSION":
      return [
        button("createSession", "Create Session", true),
        button("joinSession", "Join Session", false),
        button("leaveRoom", "Leave Room", false),
        button("leaveSession", "Leave Session", false, true),
        button("signOut", "Sign Out", false),
        button("account", "Account", false),
        button("refresh", "Refresh", false),
      ];
    case "IN_ROOM_IN_SESSION":
      return [
        button("leaveSession", "Leave Session", true),
        button("leaveRoom", "Leave Room", false),
        button("createSession", "Create Session", false, true),
        button("joinSession", "Join Session", false, true),
        button("signOut", "Sign Out", false),
        button("account", "Account", false),
        button("refresh", "Refresh", false),
      ];
  }
}

function button(
  id: string,
  label: string,
  primary: boolean,
  disabled = false
): ButtonDef {
  return {
    id,
    label,
    primary,
    visible: true,
    disabled,
  };
}
