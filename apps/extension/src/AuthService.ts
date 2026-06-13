import * as vscode from "vscode";
import * as http from "node:http";

import type { Draft, Room, Session } from "@conduit/shared-types";

const ACCESS_TOKEN_SECRET_KEY = "conduit.accessToken";
const USER_STATE_KEY = "conduit.user";

export interface ConduitUser {
  readonly id: string;
  readonly email: string | undefined;
  readonly username?: string;
}

export interface AuthState {
  readonly accessToken: string | undefined;
  readonly user: ConduitUser | undefined;
}

export interface AuthenticatedState {
  readonly accessToken: string;
  readonly user: ConduitUser;
}

export class AuthService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly websocketUrl: string
  ) {}

  private isTokenExpired(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return true;
      }
      const payloadPart = parts[1];
      if (!payloadPart) {
        return true;
      }
      const payloadJson = Buffer.from(payloadPart, "base64").toString("utf-8");
      const payload = JSON.parse(payloadJson) as { exp?: number };
      if (!payload.exp) {
        return false;
      }
      const bufferSeconds = 60; // 1-minute buffer
      return payload.exp < Date.now() / 1000 + bufferSeconds;
    } catch {
      return true;
    }
  }

  public async getState(): Promise<AuthState> {
    const accessToken = await this.context.secrets.get(ACCESS_TOKEN_SECRET_KEY);
    const user = this.context.globalState.get<ConduitUser>(USER_STATE_KEY);

    if (accessToken) {
      if (this.isTokenExpired(accessToken)) {
        await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
        await this.context.globalState.update(USER_STATE_KEY, undefined);
        return {
          accessToken: undefined,
          user: undefined
        };
      }
    }

    return {
      accessToken,
      user
    };
  }

  public async requireState(): Promise<AuthenticatedState> {
    const state = await this.getState();
    if (!state.accessToken || !state.user) {
      throw new Error(
        "Sign in to Conduit before creating or joining sessions."
      );
    }

    return {
      accessToken: state.accessToken,
      user: state.user
    };
  }

  public async signIn(email: string, password: string): Promise<ConduitUser> {
    const payload = await this.fetchJson<{
      readonly accessToken: string;
      readonly user: ConduitUser;
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    await this.context.secrets.store(
      ACCESS_TOKEN_SECRET_KEY,
      payload.accessToken
    );
    await this.context.globalState.update(USER_STATE_KEY, payload.user);

    try {
      const gitName = this.context.globalState.get<string>("conduit.userName") ?? "Conduit User";
      if (gitName !== "Conduit User") {
        await this.updateProfileName(gitName);
      }
    } catch (err) {
      console.error("[conduit-extension] Failed to sync profile name on sign in:", err);
    }

    return this.context.globalState.get<ConduitUser>(USER_STATE_KEY) ?? payload.user;
  }

  public async signInWithGitHub(): Promise<ConduitUser> {
    return new Promise<ConduitUser>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
          if (reqUrl.pathname === "/callback") {
            const accessToken = reqUrl.searchParams.get("accessToken");
            const userJson = reqUrl.searchParams.get("user");

            if (!accessToken || !userJson) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Authentication Failed</h1><p>Missing access token or user info.</p>");
              reject(new Error("Authentication failed: missing credentials"));
              return;
            }

            const user = JSON.parse(userJson) as ConduitUser;

            await this.context.secrets.store(ACCESS_TOKEN_SECRET_KEY, accessToken);
            await this.context.globalState.update(USER_STATE_KEY, user);

            try {
              const gitName = this.context.globalState.get<string>("conduit.userName") ?? "Conduit User";
              if (gitName !== "Conduit User") {
                await this.updateProfileName(gitName);
              }
            } catch (err) {
              console.error("[conduit-extension] Failed to sync profile name on github sign in:", err);
            }

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>Conduit - Signed In</title>
                <style>
                  body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                    background-color: #0d1117;
                    color: #c9d1d9;
                  }
                  .card {
                    text-align: center;
                    padding: 40px;
                    border-radius: 12px;
                    background-color: #161b22;
                    border: 1px solid #30363d;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                  }
                  h1 {
                    color: #58a6ff;
                    margin-bottom: 16px;
                  }
                  p {
                    font-size: 16px;
                  }
                </style>
              </head>
              <body>
                <div class="card">
                  <h1>Successfully Authenticated!</h1>
                  <p>You can close this tab and return to VS Code.</p>
                </div>
              </body>
              </html>
            `);

            const finalUser = this.context.globalState.get<ConduitUser>(USER_STATE_KEY) ?? user;
            resolve(finalUser);
            server.close();
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (err) {
          res.writeHead(500);
          res.end("Internal error");
          reject(err);
          server.close();
        }
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "string" ? 0 : address?.port;
        if (!port) {
          reject(new Error("Failed to allocate local port"));
          server.close();
          return;
        }

        const authUrl = `${this.backendUrl}/auth/github?port=${port}`;
        void vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });
    });
  }

  public async signOut(): Promise<void> {
    await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
    await this.context.globalState.update(USER_STATE_KEY, undefined);
  }

  public async updateProfileName(name: string): Promise<void> {
    const state = await this.getState();
    if (!state.accessToken || !state.user) return;
    try {
      const payload = await this.fetchJson<{ readonly user: ConduitUser }>(
        "/me/profile",
        {
          method: "POST",
          headers: this.authHeaders(state.accessToken),
          body: JSON.stringify({ name })
        }
      );
      await this.context.globalState.update(USER_STATE_KEY, payload.user);
    } catch (error) {
      console.error("[conduit-extension] Failed to update profile name:", error);
    }
  }

  public async refreshMe(): Promise<ConduitUser> {
    const state = await this.requireState();
    const payload = await this.fetchJson<{ readonly user: ConduitUser }>(
      "/me",
      {
        headers: this.authHeaders(state.accessToken)
      }
    );
    await this.context.globalState.update(USER_STATE_KEY, payload.user);
    return payload.user;
  }

  public async createRoom(room: Room, accessToken: string): Promise<Room> {
    const payload = await this.fetchJson<{ readonly room: Room }>("/rooms", {
      method: "POST",
      headers: this.authHeaders(accessToken),
      body: JSON.stringify({
        ...room,
        repositoryName: room.name,
        repositoryRemoteUrl: room.repoUrl,
        repositoryOwner: room.ownerId
      })
    });
    return payload.room;
  }

  public async createSession(
    session: Session,
    accessToken: string
  ): Promise<Session> {
    const payload = await this.fetchJson<{ readonly session: Session }>(
      "/sessions",
      {
        method: "POST",
        headers: this.authHeaders(accessToken),
        body: JSON.stringify(session)
      }
    );
    return payload.session;
  }

  public async saveDraft(
    draft: Draft,
    accessToken: string
  ): Promise<Draft> {
    try {
      // Strip out the large yjsState and filesystemOps to optimize payload size
      const optimizedDraft = {
        ...draft,
        yjsState: undefined as any,
        filesystemOps: undefined as any
      };
      const payload = await this.fetchJson<{ readonly draft: Draft }>("/drafts", {
        method: "POST",
        headers: this.authHeaders(accessToken),
        body: JSON.stringify(optimizedDraft)
      });
      return payload.draft;
    } catch (error: any) {
      // Fallback: If the server cannot find the live session in memory (e.g. offline fallback/restart),
      // or if the server is running an older version that requires yjsState, retry with the full draft payload.
      const errorMsg =
        error && typeof error.message === "string" ? error.message : "";
      const isValidationError =
        errorMsg.includes("LIVE_SESSION_NOT_FOUND") ||
        errorMsg.includes("yjsState") ||
        errorMsg.includes("400") ||
        errorMsg.includes("required");
      if (isValidationError) {
        const payload = await this.fetchJson<{ readonly draft: Draft }>("/drafts", {
          method: "POST",
          headers: this.authHeaders(accessToken),
          body: JSON.stringify(draft)
        });
        return payload.draft;
      }
      throw error;
    }
  }

  public async getDraft(
    draftId: string,
    accessToken: string
  ): Promise<Draft> {
    const payload = await this.fetchJson<{ readonly draft: Draft }>(
      `/drafts/${encodeURIComponent(draftId)}`,
      {
        headers: this.authHeaders(accessToken)
      }
    );
    return payload.draft;
  }

  public async updateDraftStatus(
    draftId: string,
    status: Draft["status"],
    accessToken: string
  ): Promise<Draft> {
    const payload = await this.fetchJson<{ readonly draft: Draft }>(
      `/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "PATCH",
        headers: this.authHeaders(accessToken),
        body: JSON.stringify({ status })
      }
    );
    return payload.draft;
  }

  public async listDrafts(
    options: {
      readonly roomId: string;
      readonly branch?: string;
      readonly status?: Draft["status"];
      readonly ownerId?: string;
    },
    accessToken: string
  ): Promise<readonly Draft[]> {
    const params = new URLSearchParams({
      roomId: options.roomId
    });
    if (options.branch) {
      params.set("branch", options.branch);
    }
    if (options.status) {
      params.set("status", options.status);
    }
    if (options.ownerId) {
      params.set("ownerId", options.ownerId);
    }

    const payload = await this.fetchJson<{ readonly drafts: readonly Draft[] }>(
      `/drafts?${params.toString()}`,
      {
        headers: this.authHeaders(accessToken)
      }
    );
    return payload.drafts;
  }

  public async listMembers(
    roomId: string,
    accessToken: string
  ): Promise<readonly any[]> {
    const payload = await this.fetchJson<{ readonly members: readonly any[] }>(
      `/rooms/${roomId}/members`,
      {
        headers: this.authHeaders(accessToken)
      }
    );
    return payload.members;
  }

  public async promoteMember(
    roomId: string,
    userId: string,
    accessToken: string
  ): Promise<any> {
    return this.fetchJson(`/rooms/${roomId}/members/${userId}/promote`, {
      method: "POST",
      headers: this.authHeaders(accessToken)
    });
  }

  public async downgradeMember(
    roomId: string,
    userId: string,
    accessToken: string
  ): Promise<any> {
    return this.fetchJson(`/rooms/${roomId}/members/${userId}/downgrade`, {
      method: "POST",
      headers: this.authHeaders(accessToken)
    });
  }

  public async banMember(
    roomId: string,
    userId: string,
    reason: string | undefined,
    accessToken: string
  ): Promise<any> {
    return this.fetchJson(`/rooms/${roomId}/members/${userId}/ban`, {
      method: "POST",
      headers: this.authHeaders(accessToken),
      body: JSON.stringify({ reason })
    });
  }

  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");

    const url = `${this.backendUrl}${path}`;
    try {
      const response = await fetch(url, {
        ...init,
        headers
      });
      const body = (await response.json().catch(() => ({}))) as {
        readonly error?: string;
      };
      if (!response.ok) {
        if (response.status === 401) {
          await this.signOut();
        }
        throw new Error(
          body.error ?? `Conduit request failed with ${String(response.status)}`
        );
      }
      return body as T;
    } catch (error: any) {
      const cause = error?.cause ? ` (Cause: ${error.cause.message || String(error.cause)})` : "";
      console.error(`[conduit-extension] fetchJson failed for URL: ${url}`, error);
      throw new Error(`Connection failed: ${error.message || String(error)}${cause}`);
    }
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`
    };
  }

  public get backendUrl(): string {
    const configUrl = vscode.workspace.getConfiguration("conduit").get<string>("backendUrl");
    if (configUrl) {
      return configUrl.replace(/\/$/u, "");
    }
    const parsedUrl = new URL(this.websocketUrl);
    parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
    parsedUrl.pathname = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString().replace(/\/$/u, "");
  }
}
