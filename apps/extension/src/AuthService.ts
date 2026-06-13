import * as http from "http";
import * as vscode from "vscode";
import type { Draft } from "@codesync/shared-types";

export interface AuthState {
  accessToken?: string;
  user?: any;
}

export class AuthService {
  private readonly globalState: vscode.Memento;
  private readonly tokenKey = "codesync:accessToken";
  private readonly userKey = "codesync:user";
  private _state: AuthState = {};
  private readonly _onDidAuthStateChange = new vscode.EventEmitter<AuthState>();
  public readonly onDidAuthStateChange = this._onDidAuthStateChange.event;

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
    this._state = {
      accessToken: this.globalState.get<string>(this.tokenKey),
      user: this.globalState.get<any>(this.userKey),
    };
  }

  getState(): AuthState {
    return this._state;
  }

  private getBackendUrl(): string {
    const config = vscode.workspace.getConfiguration("codesync");
    return config.get<string>("backendUrl") || "http://localhost:3000";
  }

  async signIn(): Promise<AuthState> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const parsedUrl = new URL(req.url || "", `http://localhost`);
          if (parsedUrl.pathname === "/callback") {
            const accessToken = parsedUrl.searchParams.get("accessToken");
            const userStr = parsedUrl.searchParams.get("user");

            if (accessToken && userStr) {
              const user = JSON.parse(decodeURIComponent(userStr));
              await this.updateState(accessToken, user);

              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`
                <html>
                  <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                    <h1 style="color: #4CAF50;">Authentication Successful!</h1>
                    <p>You can close this tab and return to VS Code.</p>
                  </body>
                </html>
              `);
              resolve(this._state);
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Authentication failed: Missing parameters");
              reject(new Error("Authentication failed: Missing parameters"));
            }
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Server Error");
          reject(err);
        } finally {
          server.close();
        }
      });

      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const port = address.port;
          const backendUrl = this.getBackendUrl();
          const authUrl = `${backendUrl}/auth/github?port=${port}`;
          try {
            await vscode.env.openExternal(vscode.Uri.parse(authUrl));
          } catch (err) {
            server.close();
            reject(err);
          }
        } else {
          server.close();
          reject(new Error("Failed to get local server port"));
        }
      });

      setTimeout(() => {
        server.close();
        reject(new Error("Authentication timed out"));
      }, 5 * 60 * 1000);
    });
  }

  async signOut(): Promise<void> {
    await this.updateState(undefined, undefined);
  }

  private async updateState(accessToken?: string, user?: any): Promise<void> {
    this._state = { accessToken, user };
    await this.globalState.update(this.tokenKey, accessToken);
    await this.globalState.update(this.userKey, user);
    this._onDidAuthStateChange.fire(this._state);
  }

  async refreshMe(): Promise<any> {
    const { accessToken } = this._state;
    if (!accessToken) {
      throw new Error("Not authenticated");
    }

    const backendUrl = this.getBackendUrl();
    const response = await fetch(`${backendUrl}/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh user profile: ${response.statusText}`);
    }

    const user = await response.json();
    await this.updateState(accessToken, user);
    return user;
  }

  async updateProfileName(name: string): Promise<any> {
    const { accessToken } = this._state;
    if (!accessToken) {
      throw new Error("Not authenticated");
    }

    const backendUrl = this.getBackendUrl();
    const response = await fetch(`${backendUrl}/auth/profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update profile name: ${response.statusText}`);
    }

    const user = await response.json();
    await this.updateState(accessToken, user);
    return user;
  }

  async saveDraft(draft: Draft, token: string): Promise<Draft> {
    const backendUrl = this.getBackendUrl();
    const response = await fetch(`${backendUrl}/drafts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(draft),
    });

    if (!response.ok) {
      throw new Error(`Failed to save draft: ${response.statusText}`);
    }

    return response.json();
  }

  async updateDraftStatus(id: string, status: Draft["status"], token: string): Promise<Draft> {
    const backendUrl = this.getBackendUrl();
    const response = await fetch(`${backendUrl}/drafts/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update draft status: ${response.statusText}`);
    }

    return response.json();
  }

  async listDrafts(options: any = {}, token: string): Promise<Draft[]> {
    const backendUrl = this.getBackendUrl();
    const query = new URLSearchParams(options).toString();
    const response = await fetch(`${backendUrl}/drafts${query ? `?${query}` : ""}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list drafts: ${response.statusText}`);
    }

    return response.json();
  }
}
