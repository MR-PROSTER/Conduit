import * as vscode from "vscode";
import type { Draft } from "@codesync/shared-types";
import type {
  BroadcastHub,
  CollaborationSnapshot,
} from "./broadcast.js";
import type { BranchSessionRegistry, SessionDescriptor } from "./BranchSessionRegistry.js";
import type { CodeSyncWebSocketClient } from "./wsClient.js";
import type { AuthService } from "./AuthService.js";

interface SidebarState {
  authed: boolean;
  user: {
    id: string;
    name: string;
  } | null;
  localUserId: string;
  localUserName: string;
  snapshot: CollaborationSnapshot;
  knownSession: SessionDescriptor | null;
  drafts: readonly Draft[];
}

interface SidebarMessage {
  type:
    | "signIn"
    | "signOut"
    | "createSession"
    | "joinSession"
    | "leaveSession"
    | "switchBranch"
    | "restoreDraft";
  draftId?: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "codesync.sidebar";

  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly broadcastHub: BroadcastHub,
    private readonly branchSessionRegistry: BranchSessionRegistry,
    private readonly wsClient: CodeSyncWebSocketClient,
    private readonly websocketUrl: string,
    private readonly authService: AuthService,
    private readonly localUserId: string,
    private readonly localUserName: string,
    private readonly extensionUri: vscode.Uri
  ) {
    this.disposables.push(
      this.authService.onDidAuthStateChange(() => {
        void this.refreshView();
      })
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    const initialState = this.buildState();
    webviewView.webview.html = this.renderHtml(webviewView.webview, initialState);

    this.disposables.push(
      this.broadcastHub.onDidBroadcast((event) => {
        if (event.type !== "snapshot") {
          return;
        }

        void this.refreshView(event.snapshot);
      }),
      webviewView.webview.onDidReceiveMessage((message: SidebarMessage) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
      })
    );

    void this.refreshView(initialState.snapshot);
  }

  dispose(): void {
    this.view = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleMessage(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case "signIn":
        await vscode.commands.executeCommand("codesync.signIn");
        break;
      case "signOut":
        await vscode.commands.executeCommand("codesync.signOut");
        break;
      case "createSession":
        await vscode.commands.executeCommand("codesync.createSession");
        break;
      case "joinSession":
        await vscode.commands.executeCommand("codesync.joinSession");
        break;
      case "leaveSession":
        await vscode.commands.executeCommand("codesync.leaveSession");
        break;
      case "switchBranch":
        await vscode.commands.executeCommand("codesync.switchBranch");
        break;
      case "restoreDraft":
        await vscode.commands.executeCommand("codesync.restoreDrafts");
        break;
    }

    await this.refreshView();
  }

  private buildState(snapshot = this.broadcastHub.getSnapshot()): SidebarState {
    const authState = this.authService.getState();
    const user = authState.user?.id
      ? {
          id: String(authState.user.id),
          name: String(authState.user.name || this.localUserName),
        }
      : null;
    const knownSession = snapshot.session?.branch
      ? this.branchSessionRegistry.get(snapshot.session.branch) ?? null
      : null;

    return {
      authed: Boolean(authState.accessToken && authState.user),
      user,
      localUserId: this.localUserId,
      localUserName: this.localUserName,
      snapshot,
      knownSession,
      drafts: [],
    };
  }

  private async refreshView(snapshot = this.broadcastHub.getSnapshot()): Promise<void> {
    const nextState = this.buildState(snapshot);
    nextState.drafts = await this.loadDrafts(nextState.authed);
    await this.view?.webview.postMessage({
      type: "state",
      state: nextState,
    });
  }

  private async loadDrafts(authed: boolean): Promise<readonly Draft[]> {
    if (!authed) {
      return [];
    }

    try {
      return await this.wsClient.listDraftsFn({ status: "active" });
    } catch {
      return [];
    }
  }

  private renderHtml(webview: vscode.Webview, state: SidebarState): string {
    const nonce = createNonce();
    const initialState = serializeState(state);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 88%, black 12%);
      --panel-2: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, var(--vscode-sideBar-background) 28%);
      --border: color-mix(in srgb, var(--vscode-editorWidget-border) 80%, transparent);
      --soft: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-2: var(--vscode-button-hoverBackground);
      --good: #43d17a;
      --warn: #ffbf3c;
      --bad: #ff6b6b;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 18%, transparent) 0, transparent 32%),
        linear-gradient(180deg, var(--panel) 0%, var(--vscode-sideBar-background) 55%);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }

    .shell {
      padding: 14px;
      display: grid;
      gap: 12px;
    }

    .hero {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      background: rgba(0, 0, 0, 0.14);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
    }

    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .kicker {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 11px;
      color: var(--soft);
      margin-bottom: 8px;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      font-size: 11px;
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      flex: 0 0 auto;
      background: var(--soft);
    }

    .grid {
      display: grid;
      gap: 12px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      background: color-mix(in srgb, var(--panel-2) 92%, transparent);
    }

    .card h2 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--soft);
    }

    .muted {
      color: var(--soft);
      font-size: 12px;
      line-height: 1.45;
    }

    .meta {
      display: grid;
      gap: 8px;
      font-size: 12px;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .meta-label {
      color: var(--soft);
    }

    .collaborators,
    .drafts {
      display: grid;
      gap: 8px;
    }

    .person,
    .draft {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.03);
    }

    .person-main,
    .draft-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .person-name,
    .draft-title {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .person-sub,
    .draft-sub {
      font-size: 12px;
      color: var(--soft);
      margin-top: 2px;
    }

    .stack {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--accent);
      color: var(--vscode-button-foreground);
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    button.secondary {
      background: transparent;
    }

    button:hover {
      background: var(--accent-2);
    }

    .empty {
      padding: 12px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--soft);
      font-size: 12px;
    }

    .auth-banner {
      display: grid;
      gap: 10px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="kicker">CodeSync Sidebar</div>
      <div class="title">
        <div>
          <h1>Sessions, collaborators, and drafts</h1>
          <div class="muted" id="subtitle"></div>
        </div>
        <div class="pill" id="connectionPill"></div>
      </div>
    </section>

    <section class="grid" id="content"></section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialState = ${initialState};
    const content = document.getElementById('content');
    const subtitle = document.getElementById('subtitle');
    const connectionPill = document.getElementById('connectionPill');

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function stateLabel(state) {
      switch (state) {
        case 'connected': return 'Connected';
        case 'connecting': return 'Connecting';
        case 'reconnecting': return 'Reconnecting';
        case 'error': return 'Error';
        default: return 'Disconnected';
      }
    }

    function render(state) {
      const authed = Boolean(state.authed && state.user);
      const snapshot = state.snapshot || {};
      const collaborators = Array.isArray(snapshot.collaborators) ? snapshot.collaborators : [];
      const drafts = Array.isArray(state.drafts) ? state.drafts : [];
      const roomName = snapshot.room?.name || snapshot.roomId || 'No room selected';
      const branchName = snapshot.session?.branch || state.knownSession?.branch || 'No branch';
      const sessionId = snapshot.session?.id || state.knownSession?.sessionId || 'No session';
      const websocketUrl = snapshot.websocketUrl || ${JSON.stringify(this.websocketUrl)};

      subtitle.textContent = authed
        ? 'Signed in as ' + (state.user?.name || state.localUserName || 'Unknown')
        : 'Sign in to create, join, and restore sessions.';

      connectionPill.innerHTML = '<span class="dot" style="background:' + (snapshot.state === 'connected' ? 'var(--good)' : snapshot.state === 'error' ? 'var(--bad)' : 'var(--warn)') + '"></span>' +
        escapeHtml(stateLabel(snapshot.state));

      const sessionCard = authed
        ? \`
          <section class="card">
            <h2>Room & Session</h2>
            <div class="meta">
              <div class="meta-row"><span class="meta-label">Room</span><span>\${escapeHtml(roomName)}</span></div>
              <div class="meta-row"><span class="meta-label">Branch</span><span>\${escapeHtml(branchName)}</span></div>
              <div class="meta-row"><span class="meta-label">Session</span><span>\${escapeHtml(sessionId)}</span></div>
              <div class="meta-row"><span class="meta-label">Participants</span><span>\${collaborators.length}</span></div>
              <div class="meta-row"><span class="meta-label">WebSocket</span><span>\${escapeHtml(websocketUrl)}</span></div>
            </div>
          </section>\`
        : \`
          <section class="card auth-banner">
            <h2>Sign In</h2>
            <div class="muted">Sign in to create or join a room, manage drafts, and see collaborators.</div>
            <div class="actions">
              <button data-action="signIn">Sign in</button>
            </div>
          </section>\`;

      const collaboratorsCard = authed
        ? \`
          <section class="card">
            <h2>Collaborators</h2>
            \${collaborators.length ? \`
              <div class="collaborators">
                \${collaborators.map((collaborator) => \`
                  <div class="person">
                    <div class="person-main">
                      <span class="dot" style="background:\${escapeHtml(collaborator.color || '#888')}\"></span>
                      <div class="stack">
                        <div class="person-name">\${escapeHtml(collaborator.name || collaborator.userId || 'Anonymous')}</div>
                        <div class="person-sub">\${escapeHtml(collaborator.userId || '')}</div>
                      </div>
                    </div>
                    <div class="muted">\${escapeHtml(collaborator.status || 'online')}</div>
                  </div>\`).join('')}
              </div>\`
            : '<div class="empty">No collaborators yet.</div>'}
          </section>\`
        : '';

      const draftsCard = authed
        ? \`
          <section class="card">
            <h2>Drafts</h2>
            \${drafts.length ? \`
              <div class="drafts">
                \${drafts.map((draft) => \`
                  <div class="draft">
                    <div class="draft-main">
                      <div class="stack">
                        <div class="draft-title">\${escapeHtml(draft.branch || 'Draft')}</div>
                        <div class="draft-sub">\${escapeHtml(draft.id)} · \${escapeHtml(draft.status)} · \${escapeHtml(draft.createdAt || '')}</div>
                      </div>
                    </div>
                    <button class="secondary" data-action="restoreDraft" data-draft-id="\${escapeHtml(draft.id)}">Restore</button>
                  </div>\`).join('')}
              </div>\`
            : '<div class="empty">No active drafts available.</div>'}
          </section>\`
        : '';

      const actionsCard = authed
        ? \`
          <section class="card">
            <h2>Actions</h2>
            <div class="actions">
              <button data-action="createSession">Create Session</button>
              <button data-action="joinSession">Join Session</button>
              <button data-action="switchBranch">Switch Branch</button>
              <button class="secondary" data-action="leaveSession">Leave Session</button>
              <button class="secondary" data-action="signOut">Sign out</button>
            </div>
          </section>\`
        : '';

      content.innerHTML = sessionCard + collaboratorsCard + draftsCard + actionsCard;
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) {
        return;
      }

      vscode.postMessage({
        type: button.dataset.action,
        draftId: button.dataset.draftId
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'state') {
        return;
      }

      render(message.state);
    });

    render(initialState);
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 16; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function serializeState(state: SidebarState): string {
  return JSON.stringify(state).replace(/</g, "\\u003c");
}
