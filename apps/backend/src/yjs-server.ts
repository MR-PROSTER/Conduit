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
  console.log(`[WS-DEBUG] setupWSConnection called for roomKey: ${roomKey}`);
  
  const originalOn = ws.on;
  ws.on = function (this: any, event: string, listener: any) {
    if (event === "message") {
      const originalListener = listener;
      listener = function (this: any, data: any, isBinary: boolean) {
        console.log(`[WS-DEBUG] Received message for roomKey ${roomKey}. Type: ${data ? data.constructor.name : "unknown"}, length: ${data ? data.length || data.byteLength : 0}, isBinary: ${isBinary}`);
        try {
          return originalListener.apply(this, arguments as any);
        } catch (err) {
          console.error(`[WS-DEBUG] Error in message listener:`, err);
          throw err;
        }
      };
    }
    return originalOn.call(this, event, listener);
  };

  const originalSend = ws.send;
  ws.send = function (this: any, data: any, options: any, cb: any) {
    console.log(`[WS-DEBUG] Sending message for roomKey ${roomKey}. Type: ${data ? data.constructor.name : "unknown"}, length: ${data ? data.length || data.byteLength : 0}`);
    return originalSend.call(this, data, options, cb);
  };

  ySetupWSConnection(ws, req, { docName: roomKey });
}

