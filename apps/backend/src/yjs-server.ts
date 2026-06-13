import * as Y from "yjs";
// @ts-ignore
import { docs as yDocs, setupWSConnection as ySetupWSConnection } from "y-websocket/bin/utils";

// Export the global document store keyed by roomKey
export const docs = yDocs as Map<string, Y.Doc>;

/**
 * Setup a new WebSocket connection for a Y.Doc, delegating to the y-websocket server implementation.
 * @param ws The WebSocket connection instance
 * @param req The upgrade request
 * @param roomKey The room key for the Y.Doc
 */
export function setupWSConnection(ws: any, req: any, roomKey: string): void {
  ySetupWSConnection(ws, req, { docName: roomKey });
}
