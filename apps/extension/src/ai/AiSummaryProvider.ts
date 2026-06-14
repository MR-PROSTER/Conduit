import * as vscode from "vscode";
import * as Y from "yjs";
import type { ChatMessage } from "@conduit/shared-types";
import type { ConduitWebSocketClient } from "../wsClient.js";
import type { BroadcastHub } from "../broadcast.js";
import type { AuthService } from "../AuthService.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

export class AiSummaryProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "conduit.aiSummary";

    private readonly disposables: vscode.Disposable[] = [];
    private view: vscode.WebviewView | undefined;
    private activeDocListener: Y.Doc | undefined = undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly broadcastHub: BroadcastHub,
        private readonly authService: AuthService,
        private readonly wsClient: ConduitWebSocketClient
    ) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                void this.refresh();
            })
        );
    }

    public async refresh(): Promise<void> {
        this.setupDocListener();
        await this.refreshView();
    }

    private setupDocListener(): void {
        const activeDoc = this.wsClient.getActiveDoc();
        if (activeDoc === this.activeDocListener) {
            return;
        }

        if (this.activeDocListener) {
            try {
                const chatArray = this.activeDocListener.getArray<string>("chat-messages");
                chatArray.unobserve(this.onChatChanged);
            } catch (err) {
                console.warn("Failed to unobserve chat array", err);
            }
        }

        this.activeDocListener = activeDoc;
        if (activeDoc) {
            try {
                const chatArray = activeDoc.getArray<string>("chat-messages");
                chatArray.observe(this.onChatChanged);
            } catch (err) {
                console.warn("Failed to observe chat array", err);
            }
        }
    }

    private onChatChanged = (): void => {
        void this.refreshView();
    };

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };

        webviewView.webview.html = this.renderHtml(webviewView.webview);

        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((message) => {
                void this.handleMessage(message);
            }),
            webviewView.onDidDispose(() => {
                if (this.activeDocListener) {
                    try {
                        const chatArray = this.activeDocListener.getArray<string>("chat-messages");
                        chatArray.unobserve(this.onChatChanged);
                    } catch { }
                    this.activeDocListener = undefined;
                }
                this.view = undefined;
            })
        );

        void this.refresh();
    }

    dispose(): void {
        if (this.activeDocListener) {
            try {
                const chatArray = this.activeDocListener.getArray<string>("chat-messages");
                chatArray.unobserve(this.onChatChanged);
            } catch { }
            this.activeDocListener = undefined;
        }
        this.view = undefined;
        vscode.Disposable.from(...this.disposables).dispose();
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case "ready":
                void this.refresh();
                break;
            case "openDiff":
                if (message.stepId && message.messageId) {
                    await this.openDiffEditor(message.stepId, message.messageId);
                }
                break;
        }
    }

    private async openDiffEditor(stepId: string, messageId: string): Promise<void> {
        const activeDoc = this.wsClient.getActiveDoc();
        if (!activeDoc) {
            return;
        }

        try {
            const chatArray = activeDoc.getArray<string>("chat-messages");
            const messages = chatArray.toArray().map((str: string) => {
                try { return JSON.parse(str) as ChatMessage; } catch { return null; }
            }).filter((m): m is ChatMessage => m !== null);

            const targetMsg = messages.find((m) => m.id === messageId);
            const step = targetMsg?.agentSteps?.find((s) => s.id === stepId);
            if (step?.diff) {
                const os = await import("node:os");
                const fs = await import("node:fs/promises");
                const path = await import("node:path");

                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
                const absPath = path.join(root, step.diff.filePath);

                // Read current (after-edit) content from disk
                const afterContent = await fs.readFile(absPath, "utf-8").catch(() => "");

                // Reconstruct before-content from the diff hunks
                const beforeLines: string[] = [];
                for (const hunk of step.diff.hunks) {
                    for (const line of hunk.lines) {
                        if (line.type === "del" || line.type === "ctx") {
                            beforeLines.push(line.content);
                        }
                    }
                }
                const beforeContent = beforeLines.join("\n");

                // Write before-content to a temp file
                const tmpDir = os.tmpdir();
                const tmpFile = path.join(tmpDir, `conduit-before-${Date.now()}-${path.basename(step.diff.filePath)}`);
                await fs.writeFile(tmpFile, beforeContent, "utf-8");

                const beforeUri = vscode.Uri.file(tmpFile);
                const afterUri = vscode.Uri.file(absPath);
                const title = `${path.basename(step.diff.filePath)}: Before ↔ After (Agent Edit)`;

                await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title);
            }
        } catch (err) {
            console.error("Failed to open diff editor for AI Summary:", err);
        }
    }

    private async refreshView(): Promise<void> {
        if (!this.view) {
            return;
        }

        const stateManager = getStateManager();
        const conduitState = stateManager.get();
        const activeDoc = this.wsClient.getActiveDoc();

        const roomName = conduitState.room?.name ?? "No Room Connected";
        const branchName = conduitState.session?.branch ?? "No Branch";
        const sessionId = conduitState.session?.id ?? "No Session";
        const isConnected = conduitState.state === "IN_ROOM_IN_SESSION" || conduitState.state === "IN_ROOM_NO_SESSION";

        let totalMessages = 0;
        let totalAiEdits = 0;
        let aiCodeLinesTotal = 0;
        let aiLinesAdded = 0;
        let aiLinesDeleted = 0;

        const userLinesMap = new Map<string, number>();
        const aiEditsList: any[] = [];

        if (activeDoc) {
            try {
                const chatArray = activeDoc.getArray<string>("chat-messages");
                const messages = chatArray.toArray().map((str: string) => {
                    try { return JSON.parse(str) as ChatMessage; } catch { return null; }
                }).filter((m): m is ChatMessage => m !== null);

                totalMessages = messages.length;

                // Group messages by thread to find the preceding user message triggers
                const threadMessages = new Map<string, ChatMessage[]>();
                for (const msg of messages) {
                    const list = threadMessages.get(msg.threadId) ?? [];
                    list.push(msg);
                    threadMessages.set(msg.threadId, list);
                }

                for (const [_, msgsInThread] of threadMessages.entries()) {
                    let lastUserMsg: ChatMessage | null = null;
                    for (const msg of msgsInThread) {
                        if (msg.role === "user") {
                            lastUserMsg = msg;
                        } else if (msg.role === "assistant") {
                            const triggeringUser = lastUserMsg ? (lastUserMsg.senderName || lastUserMsg.senderId) : "Anonymous User";
                            const triggeringPrompt = lastUserMsg ? lastUserMsg.content : "AI task request";

                            if (msg.agentSteps) {
                                for (const step of msg.agentSteps) {
                                    if (step.type === "edit" && step.diff) {
                                        totalAiEdits++;
                                        let additions = 0;
                                        let deletions = 0;
                                        if (step.diff.hunks) {
                                            for (const hunk of step.diff.hunks) {
                                                for (const line of hunk.lines) {
                                                    if (line.type === "add") additions++;
                                                    else if (line.type === "del") deletions++;
                                                }
                                            }
                                        }

                                        aiLinesAdded += additions;
                                        aiLinesDeleted += deletions;
                                        aiCodeLinesTotal += additions + deletions;

                                        // Attribute the code changes (additions) to the triggering user
                                        const currentVal = userLinesMap.get(triggeringUser) ?? 0;
                                        userLinesMap.set(triggeringUser, currentVal + additions);

                                        aiEditsList.push({
                                            id: step.id,
                                            messageId: msg.id,
                                            userName: triggeringUser,
                                            time: msg.createdAt || new Date().toISOString(),
                                            chatPrompt: triggeringPrompt,
                                            filePath: step.diff.filePath,
                                            additions,
                                            deletions
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error computing AI Summary statistics:", err);
            }
        }

        // Sort edits list: newest first
        aiEditsList.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

        // Calculate user percentages
        const userPercentages: any[] = [];
        let totalAttributedLines = 0;
        for (const [_, lines] of userLinesMap.entries()) {
            totalAttributedLines += lines;
        }

        for (const [userName, lines] of userLinesMap.entries()) {
            const pct = totalAttributedLines > 0 ? Math.round((lines / totalAttributedLines) * 100) : 0;
            userPercentages.push({
                userName,
                lineCount: lines,
                percentage: pct
            });
        }
        userPercentages.sort((a, b) => b.lineCount - a.lineCount);

        const summaryData = {
            roomName,
            branchName,
            sessionId,
            isConnected,
            totalMessages,
            totalAiEdits,
            aiCodeLinesTotal,
            aiLinesAdded,
            aiLinesDeleted,
            userPercentages,
            aiEditsList
        };

        await this.view.webview.postMessage({
            type: "updateState",
            data: summaryData
        });
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #0b0f14);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background, #101418) 90%, #000);
      --border: color-mix(in srgb, var(--vscode-editorWidget-border, #202428) 85%, transparent);
      --fg: var(--vscode-foreground, #cccccc);
      --soft: var(--vscode-descriptionForeground, #888888);
      --accent: var(--vscode-button-background, #efbf8d);
      --accent-hover: var(--vscode-button-hoverBackground, #f1c999);
      --added: #50d37c;
      --deleted: #ff6b6b;
      --card-bg: rgba(255, 255, 255, 0.025);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      background-color: var(--bg);
      overflow-y: auto;
    }

    h3 {
      margin: 0 0 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--soft);
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
    }

    .section {
      margin-bottom: 20px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }

    /* Grid for basic info */
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .info-card {
      display: flex;
      flex-direction: column;
      background: rgba(0, 0, 0, 0.15);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .info-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--soft);
      margin-bottom: 3px;
    }
    .info-value {
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .info-value.code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }

    /* AI code written stats */
    .metric-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .metric-value {
      font-size: 16px;
      font-weight: bold;
    }
    .progress-bar-container {
      height: 6px;
      background: rgba(255,255,255,0.08);
      border-radius: 3px;
      overflow: hidden;
      display: flex;
      margin-bottom: 12px;
    }
    .bar-added { background: var(--added); height: 100%; }
    .bar-deleted { background: var(--deleted); height: 100%; }

    /* Contributor list */
    .contributor-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.015);
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }
    .contributor-name {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .contributor-stats {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .contributor-bar {
      height: 4px;
      border-radius: 2px;
      background: var(--accent);
      margin-top: 4px;
    }

    /* Edits feed list */
    .edit-item {
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.12);
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 150ms ease;
    }
    .edit-item:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .edit-header {
      display: flex;
      justify-content: space-between;
      color: var(--soft);
      font-size: 10px;
      margin-bottom: 4px;
    }
    .edit-user {
      font-weight: bold;
      color: var(--fg);
    }
    .edit-prompt {
      font-style: italic;
      color: var(--soft);
      margin-bottom: 6px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .edit-file-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .edit-file {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--accent);
      max-width: 70%;
    }
    .edit-diff-count {
      display: flex;
      gap: 6px;
      font-weight: bold;
    }
    .diff-add { color: var(--added); }
    .diff-del { color: var(--deleted); }
    
    .empty-state {
      text-align: center;
      color: var(--soft);
      padding: 20px 10px;
      font-style: italic;
    }
  </style>
</head>
<body>

  <!-- 1. Basic Info Section -->
  <div class="section">
    <h3>Basic Session Info</h3>
    <div class="grid">
      <div class="info-card">
        <span class="info-label">Room</span>
        <span class="info-value" id="room-name">-</span>
      </div>
      <div class="info-card">
        <span class="info-label">Branch</span>
        <span class="info-value code" id="branch-name">-</span>
      </div>
      <div class="info-card" style="grid-column: span 2;">
        <span class="info-label">Session ID</span>
        <span class="info-value code" id="session-id">-</span>
      </div>
      <div class="info-card">
        <span class="info-label">Chats</span>
        <span class="info-value" id="total-messages">0</span>
      </div>
      <div class="info-card">
        <span class="info-label">AI Edits</span>
        <span class="info-value" id="total-ai-edits">0</span>
      </div>
    </div>
  </div>

  <!-- 2. AI Code Distribution -->
  <div class="section">
    <h3>AI Written Code</h3>
    
    <div class="metric-row">
      <span class="info-label">Total Lines Written</span>
      <span class="metric-value" id="ai-total-lines">0</span>
    </div>
    
    <div class="progress-bar-container">
      <div class="bar-added" id="bar-added-pct" style="width: 0%"></div>
      <div class="bar-deleted" id="bar-deleted-pct" style="width: 0%"></div>
    </div>
    
    <div style="display: flex; justify-content: space-between; margin-bottom: 14px; font-size: 10px;">
      <span style="color: var(--added)"><span id="lines-added">0</span> additions</span>
      <span style="color: var(--deleted)"><span id="lines-deleted">0</span> deletions</span>
    </div>

    <span class="info-label" style="display: block; margin-bottom: 8px;">User Contribution (%)</span>
    <div id="contributors-container">
      <div class="empty-state">No user contributions tracked yet.</div>
    </div>
  </div>

  <!-- 3. AI File Edits Feed -->
  <div class="section">
    <h3>AI Edits Feed</h3>
    <div id="edits-feed-container">
      <div class="empty-state">No AI edits recorded yet.</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Signal ready to host
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'updateState') {
        const data = message.data;

        // 1. Update Basic Info
        document.getElementById('room-name').textContent = data.roomName;
        document.getElementById('branch-name').textContent = data.branchName;
        document.getElementById('session-id').textContent = data.sessionId;
        document.getElementById('total-messages').textContent = data.totalMessages;
        document.getElementById('total-ai-edits').textContent = data.totalAiEdits;

        // 2. Update AI Written Code stats
        document.getElementById('ai-total-lines').textContent = data.aiCodeLinesTotal;
        document.getElementById('lines-added').textContent = '+' + data.aiLinesAdded;
        document.getElementById('lines-deleted').textContent = '-' + data.aiLinesDeleted;

        const totalDiff = data.aiLinesAdded + data.aiLinesDeleted;
        if (totalDiff > 0) {
          const addPct = (data.aiLinesAdded / totalDiff) * 100;
          const delPct = (data.aiLinesDeleted / totalDiff) * 100;
          document.getElementById('bar-added-pct').style.width = addPct + '%';
          document.getElementById('bar-deleted-pct').style.width = delPct + '%';
        } else {
          document.getElementById('bar-added-pct').style.width = '0%';
          document.getElementById('bar-deleted-pct').style.width = '0%';
        }

        // 3. Render User Contributions
        const contribContainer = document.getElementById('contributors-container');
        if (data.userPercentages && data.userPercentages.length > 0) {
          contribContainer.innerHTML = data.userPercentages.map(u => \`
            <div class="contributor-item">
              <div style="flex: 1; min-width: 0;">
                <div class="contributor-name" title="\${escapeHtml(u.userName)}">\${escapeHtml(u.userName)}</div>
                <div class="contributor-bar" style="width: \${u.percentage}%"></div>
              </div>
              <div class="contributor-stats">
                <strong>\${u.percentage}%</strong>
                <span class="subtle">(\${u.lineCount} lines)</span>
              </div>
            </div>
          \`).join('');
        } else {
          contribContainer.innerHTML = '<div class="empty-state">No user contributions tracked yet.</div>';
        }

        // 4. Render Edits Feed
        const feedContainer = document.getElementById('edits-feed-container');
        if (data.aiEditsList && data.aiEditsList.length > 0) {
          feedContainer.innerHTML = data.aiEditsList.map(item => {
            const dateStr = formatRelativeTime(item.time);
            return \`
              <div class="edit-item" onclick="openDiff('\${item.id}', '\${item.messageId}')">
                <div class="edit-header">
                  <span class="edit-user">\${escapeHtml(item.userName)}</span>
                  <span>\${escapeHtml(dateStr)}</span>
                </div>
                <div class="edit-prompt">"\${escapeHtml(item.chatPrompt)}"</div>
                <div class="edit-file-row">
                  <span class="edit-file" title="\${escapeHtml(item.filePath)}">\${escapeHtml(item.filePath.split('/').pop())}</span>
                  <div class="edit-diff-count">
                    <span class="diff-add">+\${item.additions}</span>
                    <span class="diff-del">-\${item.deletions}</span>
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        } else {
          feedContainer.innerHTML = '<div class="empty-state">No AI edits recorded yet.</div>';
        }
      }
    });

    function openDiff(stepId, messageId) {
      vscode.postMessage({ type: 'openDiff', stepId, messageId });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatRelativeTime(isoString) {
      try {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return diffMins + 'm ago';
        const diffHrs = Math.floor(diffMins / 60);
        if (diffHrs < 24) return diffHrs + 'h ago';
        return date.toLocaleDateString();
      } catch {
        return '';
      }
    }
  </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
