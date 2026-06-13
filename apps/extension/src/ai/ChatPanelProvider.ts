import * as crypto from "node:crypto";
import * as vscode from "vscode";
import * as Y from "yjs";
import type { AgentStep, ChatMessage, ChatThread, ContextRef, FileDiff, SafetyBlock } from "@conduit/shared-types";
import { LLMRouter, type ChatCompletionMessage, type ILLMProvider } from "@conduit/ai-core";
import type { BroadcastHub, CollaborationSnapshot } from "../broadcast.js";
import type { AuthService } from "../AuthService.js";
import type { ConduitWebSocketClient } from "../wsClient.js";
import type { ApiKeyStore, AIProviderName } from "./ApiKeyStore.js";
import { ContextAssembler } from "./ContextAssembler.js";
import { IntentRouter } from "./IntentRouter.js";
import { agentSystemPrompt, chatSystemPrompt, type PromptContextInfo } from "./SystemPrompts.js";
import { AgentExecutor } from "../agent/AgentExecutor.js";
import { AgentMemoryManager } from "../agent/AgentMemoryManager.js";
import { AgentSafetyLock } from "../agent/AgentSafetyLock.js";
import { AgentTools, type SafetyAction } from "../agent/AgentTools.js";

type WebviewInbound =
    | { type: "ready" }
    | { type: "send"; content: string; threadId?: string; mode?: "chat" | "agent" }
    | { type: "setProvider"; provider: AIProviderName; model?: string; ollamaUrl?: string }
    | { type: "createThread"; name?: string }
    | { type: "switchThread"; threadId: string }
    | { type: "forkThread"; messageId: string; name?: string }
    | { type: "loadHistory"; threadId?: string }
    | { type: "approveEdit"; key?: string; messageId?: string; filePath?: string }
    | { type: "rejectEdit"; key?: string; messageId?: string; filePath?: string };

type StreamEvent =
    | { type: "init"; state: PanelState }
    | { type: "threadList"; threads: ChatThread[]; activeThreadId: string | null }
    | { type: "messageAdded"; threadId: string; message: PanelMessage }
    | { type: "messageChunk"; threadId: string; messageId: string; chunk: string }
    | { type: "messageUpdated"; threadId: string; message: PanelMessage }
    | { type: "providerStatus"; status: ProviderStatus }
    | { type: "error"; message: string }
    | { type: "safetyBlock"; key: string; block: SafetyBlock }
    | { type: "step"; threadId: string; step: AgentStep };

interface ProviderStatus {
    activeProvider: AIProviderName;
    activeModel: string;
    hasKey: boolean;
    ollamaUrl: string;
    models: string[];
}

interface PanelState {
    snapshot: CollaborationSnapshot;
    threads: ChatThread[];
    activeThreadId: string | null;
    messages: PanelMessage[];
    providerStatus?: ProviderStatus;
    contextRefs: ContextRef[];
}

interface PanelMessage extends ChatMessage {
    model?: string;
    tokensUsed?: number;
    reviewed?: "approved" | "rejected";
}

interface PendingSafetyDecision {
    resolve: (action: SafetyAction) => void;
    block: SafetyBlock;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "conduit.aiPanel";

    private readonly disposables: vscode.Disposable[] = [];
    private readonly router = new LLMRouter();
    private readonly assembler = new ContextAssembler();
    private readonly threadMessages = new Map<string, PanelMessage[]>();
    private readonly pendingSafety = new Map<string, PendingSafetyDecision>();
    private view: vscode.WebviewView | undefined;
    private snapshot: CollaborationSnapshot = {
        state: "disconnected",
        participantCount: 0,
        collaborators: [],
    };
    private threads: ChatThread[] = [];
    private activeThreadId: string | null = null;
    private providerStatus: ProviderStatus | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly broadcastHub: BroadcastHub,
        private readonly authService: AuthService,
        private readonly apiKeyStore: ApiKeyStore,
        private readonly wsClient: ConduitWebSocketClient
    ) {
        this.disposables.push(
            this.broadcastHub.onDidBroadcast((event) => {
                if (event.type === "snapshot") {
                    this.snapshot = event.snapshot;
                    void this.refresh();
                }
            }),
            this.authService.onDidAuthStateChange(() => {
                void this.refreshProviderStatus();
                void this.refresh();
            })
        );
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.renderHtml(webviewView.webview);

        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((message: WebviewInbound) => {
                void this.handleMessage(message);
            }),
            webviewView.onDidDispose(() => {
                this.view = undefined;
            })
        );

        void this.refreshProviderStatus();
        void this.loadInitialState();
    }

    dispose(): void {
        for (const decision of this.pendingSafety.values()) {
            decision.resolve("skip");
        }
        this.pendingSafety.clear();
        vscode.Disposable.from(...this.disposables).dispose();
    }

    private async loadInitialState(): Promise<void> {
        await this.loadThreads();
        await this.refresh();
    }

    private async refresh(): Promise<void> {
        const state = await this.buildState();
        await this.view?.webview.postMessage({
            type: "init",
            state,
        } satisfies StreamEvent);
    }

    private async refreshProviderStatus(): Promise<void> {
        this.providerStatus = await this.buildProviderStatus();
        await this.post({ type: "providerStatus", status: this.providerStatus } satisfies StreamEvent);
    }

    private async buildState(): Promise<PanelState> {
        const activeThread = this.activeThreadId ? this.threads.find((thread) => thread.id === this.activeThreadId) : undefined;
        const messages = this.activeThreadId ? this.threadMessages.get(this.activeThreadId) ?? [] : [];
        const contextRefs: ContextRef[] = [];
        if (activeThread) {
            const refs = await this.collectContextRefs(activeThread.id);
            contextRefs.push(...refs);
        }

        return {
            snapshot: this.snapshot,
            threads: this.threads,
            activeThreadId: activeThread?.id ?? null,
            messages,
            providerStatus: this.providerStatus,
            contextRefs,
        };
    }

    private async handleMessage(message: WebviewInbound): Promise<void> {
        switch (message.type) {
            case "ready":
                await this.refresh();
                return;
            case "setProvider":
                await this.apiKeyStore.setActiveProvider(message.provider);
                if (message.model) {
                    await this.apiKeyStore.setModel(message.provider, message.model);
                }
                if (message.ollamaUrl) {
                    await this.apiKeyStore.setOllamaUrl(message.ollamaUrl);
                }
                await this.refreshProviderStatus();
                return;
            case "createThread":
                await this.createThread(message.name);
                return;
            case "switchThread":
                await this.switchThread(message.threadId);
                return;
            case "forkThread":
                await this.forkThread(message.messageId, message.name);
                return;
            case "loadHistory":
                await this.loadHistory(message.threadId ?? this.activeThreadId ?? undefined);
                return;
            case "approveEdit":
                await this.resolveDecision(message.key, message.filePath, "approved");
                return;
            case "rejectEdit":
                await this.resolveDecision(message.key, message.filePath, "rejected");
                return;
            case "send":
                await this.sendMessage(message.content, message.threadId, message.mode);
                return;
        }
    }

    private async sendMessage(content: string, threadId?: string, mode?: "chat" | "agent"): Promise<void> {
        const clean = content.trim();
        if (!clean) {
            return;
        }

        const thread = await this.ensureThread(threadId);
        const selectedMode = mode ?? IntentRouter.classifyIntent(clean);
        const activeEditor = vscode.window.activeTextEditor;
        const openFiles = vscode.workspace.textDocuments
            .filter((doc) => !doc.isUntitled)
            .map((doc) => vscode.workspace.asRelativePath(doc.uri, false));
        const context = await this.assembler.assembleContext(
            this.snapshot.session,
            openFiles,
            activeEditor,
            this.snapshot.collaborators
        );
        const contextInfo: PromptContextInfo = {
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            session: this.snapshot.session,
            openFiles,
            activeFile: activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri, false) : undefined,
            cursorLine: activeEditor ? activeEditor.selection.active.line + 1 : undefined,
            selection: activeEditor && !activeEditor.selection.isEmpty ? activeEditor.document.getText(activeEditor.selection) : undefined,
            peers: this.snapshot.collaborators,
            contextText: context.contextText,
            contextRefs: context.contextRefs,
        };

        const userMessage = await this.appendMessage(thread.id, {
            role: "user",
            content: clean,
            createdBy: this.getUserId(),
            createdAt: new Date().toISOString(),
            threadId: thread.id,
        });

        if (selectedMode === "agent") {
            await this.runAgent(thread.id, userMessage, contextInfo);
            return;
        }

        await this.runChat(thread.id, userMessage, contextInfo);
    }

    private async runChat(threadId: string, userMessage: PanelMessage, contextInfo: PromptContextInfo): Promise<void> {
        const provider = await this.buildProvider();
        const assistantId = crypto.randomUUID();
        const systemPrompt = chatSystemPrompt(contextInfo);
        const messages = this.toCompletionMessages(this.threadMessages.get(threadId) ?? []);
        const stream = provider.streamChat(messages, { systemPrompt });

        let content = "";
        let totalTokens = 0;

        for await (const chunk of stream) {
            if (chunk.content) {
                content += chunk.content;
                await this.post({ type: "messageChunk", threadId, messageId: assistantId, chunk: chunk.content } satisfies StreamEvent);
            }
            if (typeof chunk.totalTokens === "number") {
                totalTokens = chunk.totalTokens;
            }
        }

        const assistantMessage = await this.appendMessage(threadId, {
            role: "assistant",
            content,
            model: provider.modelId,
            tokensUsed: totalTokens,
            createdBy: this.getUserId(),
            createdAt: new Date().toISOString(),
            threadId,
        });
        await this.post({ type: "messageUpdated", threadId, message: assistantMessage } satisfies StreamEvent);
    }

    private async runAgent(threadId: string, userMessage: PanelMessage, contextInfo: PromptContextInfo): Promise<void> {
        const provider = await this.buildProvider();
        const safetyLock = new AgentSafetyLock();
        const peerEdits = new Map<string, string>();
        for (const peer of this.snapshot.collaborators) {
            const activeFile = (peer as any).activeFile as string | undefined;
            if (activeFile) {
                peerEdits.set(peer.name, activeFile);
            }
        }
        safetyLock.update(peerEdits);

        const agentTools = new AgentTools(safetyLock, async (block) => {
            const key = crypto.randomUUID();
            return await new Promise<SafetyAction>((resolve) => {
                this.pendingSafety.set(key, { resolve, block });
                void this.post({ type: "safetyBlock", key, block } satisfies StreamEvent);
            });
        });

        const memoryManager = new AgentMemoryManager();
        const steps: AgentStep[] = [];
        const executor = new AgentExecutor(provider, agentTools, memoryManager, (step) => {
            steps.push(step);
            void this.post({ type: "step", threadId, step } satisfies StreamEvent);
        });

        const initialMessages = [
            {
                role: "user" as const,
                content: `${agentSystemPrompt(contextInfo)}\n\nWorkspace context:\n${contextInfo.contextText || "(none)"}\n\nTask:\n${userMessage.content}`,
            },
        ];

        const result = await executor.run(userMessage.content, initialMessages);
        const fileDiffs = steps
            .filter((step) => Boolean(step.diff))
            .map((step) => {
                try {
                    return JSON.parse(step.diff ?? "null") as FileDiff;
                } catch {
                    return null;
                }
            })
            .filter((diff): diff is FileDiff => Boolean(diff));

        const agentMessage = await this.appendMessage(threadId, {
            role: "agent",
            content: result.content || "Agent completed the task.",
            model: provider.modelId,
            tokensUsed: result.totalTokens,
            agentSteps: steps,
            fileDiffs,
            createdBy: this.getUserId(),
            createdAt: new Date().toISOString(),
            threadId,
        });
        await this.post({ type: "messageUpdated", threadId, message: agentMessage } satisfies StreamEvent);
    }

    private async ensureThread(threadId?: string): Promise<ChatThread> {
        if (threadId) {
            const existing = this.threads.find((thread) => thread.id === threadId);
            if (existing) {
                this.activeThreadId = threadId;
                return existing;
            }
        }

        const created = await this.createThread();
        this.activeThreadId = created.id;
        return created;
    }

    private async createThread(name?: string): Promise<ChatThread> {
        const payload = {
            sessionId: this.snapshot.session?.id,
            name,
            createdBy: this.getUserId(),
        };
        const response = await this.apiFetch<{ thread: ChatThread }>("/chat/threads", {
            method: "POST",
            body: JSON.stringify(payload),
        });

        this.threads = [response.thread, ...this.threads.filter((thread) => thread.id !== response.thread.id)];
        this.threadMessages.set(response.thread.id, []);
        this.activeThreadId = response.thread.id;
        await this.refresh();
        return response.thread;
    }

    private async switchThread(threadId: string): Promise<void> {
        const thread = this.threads.find((item) => item.id === threadId);
        if (!thread) {
            return;
        }

        this.activeThreadId = threadId;
        await this.loadHistory(threadId);
    }

    private async forkThread(messageId: string, name?: string): Promise<void> {
        const response = await this.apiFetch<{ thread: ChatThread }>("/chat/threads", {
            method: "POST",
            body: JSON.stringify({
                sessionId: this.snapshot.session?.id,
                name,
                createdBy: this.getUserId(),
                forkedFromMessageId: messageId,
            }),
        });
        this.threads = [response.thread, ...this.threads.filter((thread) => thread.id !== response.thread.id)];
        this.threadMessages.set(response.thread.id, []);
        this.activeThreadId = response.thread.id;
        await this.loadHistory(response.thread.id);
    }

    private async loadHistory(threadId?: string): Promise<void> {
        if (!threadId) {
            return;
        }

        const result = await this.apiFetch<{ messages: PanelMessage[]; nextCursor?: string }>(`/chat/threads/${threadId}/messages`);
        this.threadMessages.set(threadId, result.messages);
        await this.refresh();
    }

    private async resolveDecision(
        key: string | undefined,
        filePath: string | undefined,
        review: "approved" | "rejected"
    ): Promise<void> {
        if (key && this.pendingSafety.has(key)) {
            const pending = this.pendingSafety.get(key);
            this.pendingSafety.delete(key);
            pending?.resolve(review === "approved" ? "proceed" : "skip");
            return;
        }

        if (filePath && this.activeThreadId) {
            const messages = this.threadMessages.get(this.activeThreadId) ?? [];
            const target = [...messages].reverse().find((message) => {
                return (message.fileDiffs ?? []).some((diff) => diff.filePath === filePath);
            });
            if (target) {
                target.reviewed = review;
                await this.refresh();
            }
        }
    }

    private async buildProviderStatus(): Promise<ProviderStatus> {
        const activeProvider = await this.apiKeyStore.getActiveProvider();
        const activeModel = (await this.apiKeyStore.getModel(activeProvider)) ?? this.router.getDefaultModelForProvider(activeProvider);
        const ollamaUrl = await this.apiKeyStore.getOllamaUrl();
        const key = await this.apiKeyStore.getKey(activeProvider);
        const hasKey = activeProvider === "ollama" ? true : Boolean(key && key.trim());
        const provider = this.router.getProvider({
            provider: activeProvider,
            apiKey: key,
            modelId: activeModel,
            ollamaUrl,
        });

        let models: string[] = [];
        try {
            models = [...(await provider.listModels())];
        } catch {
            models = [activeModel];
        }

        this.assembler.setTokenProvider(provider);
        return { activeProvider, activeModel, hasKey, ollamaUrl, models };
    }

    private async buildProvider(): Promise<ILLMProvider> {
        const activeProvider = await this.apiKeyStore.getActiveProvider();
        const activeModel = (await this.apiKeyStore.getModel(activeProvider)) ?? this.router.getDefaultModelForProvider(activeProvider);
        const ollamaUrl = await this.apiKeyStore.getOllamaUrl();
        const key = await this.apiKeyStore.getKey(activeProvider);
        const provider = this.router.getProvider({
            provider: activeProvider,
            apiKey: key,
            modelId: activeModel,
            ollamaUrl,
        });
        this.assembler.setTokenProvider(provider);
        return provider;
    }

    private toCompletionMessages(messages: readonly PanelMessage[]): readonly ChatCompletionMessage[] {
        return messages.flatMap((message): ChatCompletionMessage[] => {
            if (message.role === "user") {
                return [{ role: "user", content: message.content }];
            }
            if (message.role === "assistant" || message.role === "agent") {
                return [{ role: "assistant", content: message.content }];
            }
            return [];
        });
    }

    private async appendMessage(threadId: string, message: Partial<PanelMessage> & Pick<PanelMessage, "role" | "content" | "createdBy" | "createdAt" | "threadId">): Promise<PanelMessage> {
        const response = await this.apiFetch<{ message: PanelMessage }>(`/chat/threads/${threadId}/messages`, {
            method: "POST",
            body: JSON.stringify(message),
        });
        const stored = response.message;
        const messages = this.threadMessages.get(threadId) ?? [];
        this.threadMessages.set(threadId, [...messages, stored]);
        await this.refresh();
        return stored;
    }

    private async collectContextRefs(threadId: string): Promise<ContextRef[]> {
        const messages = this.threadMessages.get(threadId) ?? [];
        const refs: ContextRef[] = [];
        for (const message of messages) {
            for (const ref of message.contextRefs ?? []) {
                refs.push(ref);
            }
        }
        return refs;
    }

    private async loadThreads(): Promise<void> {
        const sessionId = this.snapshot.session?.id;
        if (!sessionId) {
            this.threads = [];
            return;
        }

        const response = await this.apiFetch<{ threads: ChatThread[] }>(`/chat/threads?sessionId=${encodeURIComponent(sessionId)}`);
        this.threads = response.threads;
        if (!this.activeThreadId && this.threads.length > 0) {
            this.activeThreadId = this.threads[0]!.id;
        }
        if (this.activeThreadId) {
            await this.loadHistory(this.activeThreadId);
        }
    }

    private async apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
        const auth = this.authService.getState();
        const backendUrl = vscode.workspace.getConfiguration("conduit").get<string>("backendUrl") ?? "http://localhost:4000";
        const headers = new Headers(options.headers);
        headers.set("Content-Type", "application/json");
        if (auth.accessToken) {
            headers.set("Authorization", `Bearer ${auth.accessToken}`);
        }

        const response = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error((body as any).error ?? `${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<T>;
    }

    private getUserId(): string {
        return String(this.authService.getState().user?.id ?? "anonymous");
    }

    private async post(message: StreamEvent): Promise<void> {
        await this.view?.webview.postMessage(message);
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomUUID().replace(/-/g, "");
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      --bg: color-mix(in srgb, var(--vscode-sideBar-background) 82%, #0b1020 18%);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, #101827 12%);
      --border: color-mix(in srgb, var(--vscode-editorWidget-border) 75%, transparent);
      --soft: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --good: #5de28f;
      --warn: #ffd166;
      --bad: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: radial-gradient(circle at top left, rgba(93,226,143,.12), transparent 26%), linear-gradient(180deg, var(--bg), var(--vscode-sideBar-background));
      font-family: var(--vscode-font-family);
    }
    .app { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
    .sidebar {
      border-right: 1px solid var(--border);
      padding: 12px;
      background: rgba(0,0,0,.08);
      display: grid;
      gap: 12px;
      overflow: auto;
    }
    .main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
    .header, .composer, .panel {
      border-bottom: 1px solid var(--border);
      background: rgba(0,0,0,.04);
    }
    .header {
      padding: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .panel { padding: 12px; overflow: auto; }
    .composer {
      padding: 12px;
      display: grid;
      gap: 8px;
      border-bottom: none;
    }
    .title { font-weight: 700; }
    .small { font-size: 12px; color: var(--soft); }
    .card, .thread, .msg, .setting, .context {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel);
    }
    .thread, .setting {
      padding: 10px;
      cursor: pointer;
    }
    .thread.active { outline: 2px solid var(--accent); }
    .threads, .messages, .settings, .refs { display: grid; gap: 8px; }
    .msg { padding: 10px; }
    .msg.user { border-left: 3px solid var(--good); }
    .msg.assistant { border-left: 3px solid var(--warn); }
    .msg.agent { border-left: 3px solid var(--accent); }
    .msg.system { border-left: 3px solid var(--soft); }
    .msg-meta { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--soft); margin-bottom: 6px; }
    .msg-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    textarea, input, select {
      width: 100%;
      border: 1px solid var(--border);
      background: rgba(0,0,0,.18);
      color: inherit;
      border-radius: 10px;
      padding: 10px;
      font: inherit;
    }
    textarea { min-height: 92px; resize: vertical; }
    button {
      border: 1px solid var(--border);
      background: var(--accent);
      color: var(--vscode-button-foreground);
      border-radius: 10px;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary { background: transparent; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
    .context { padding: 10px; white-space: pre-wrap; font-size: 12px; }
    .refs { font-size: 12px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; padding: 5px 8px; font-size: 11px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--soft); }
    .muted { color: var(--soft); }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div>
        <div class="title">Conduit AI</div>
        <div class="small" id="providerLine">Loading provider...</div>
      </div>
      <div class="card" style="padding:10px;">
        <div class="small">Provider</div>
        <select id="provider"></select>
        <div style="height:8px"></div>
        <input id="model" placeholder="Model" />
        <div style="height:8px"></div>
        <input id="ollamaUrl" placeholder="Ollama URL" />
        <div style="height:8px"></div>
        <button id="saveProvider">Save Provider</button>
      </div>
      <div>
        <div class="small" style="margin-bottom:8px;">Threads</div>
        <div class="threads" id="threads"></div>
      </div>
      <div>
        <div class="small" style="margin-bottom:8px;">Context refs</div>
        <div class="refs" id="refs"></div>
      </div>
    </aside>
    <main class="main">
      <div class="header">
        <div>
          <div class="title" id="threadTitle">No thread selected</div>
          <div class="small" id="threadMeta">Ready</div>
        </div>
        <div class="toolbar">
          <button id="newThread" class="secondary">New thread</button>
          <button id="forkThread" class="secondary">Fork</button>
          <button id="reloadHistory" class="secondary">Reload</button>
        </div>
      </div>
      <section class="panel">
        <div class="messages" id="messages"></div>
      </section>
      <section class="composer">
        <textarea id="input" placeholder="Ask a question or request a change..."></textarea>
        <div class="toolbar">
          <button id="send">Send</button>
          <button id="sendAgent" class="secondary">Send as Agent</button>
        </div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      snapshot: { state: 'disconnected', participantCount: 0, collaborators: [] },
      threads: [],
      activeThreadId: null,
      messages: [],
      providerStatus: null,
      contextRefs: [],
    };

    const el = (id) => document.getElementById(id);
    const threadsEl = el('threads');
    const messagesEl = el('messages');
    const refsEl = el('refs');
    const providerEl = el('provider');
    const modelEl = el('model');
    const ollamaUrlEl = el('ollamaUrl');
    const providerLineEl = el('providerLine');
    const threadTitleEl = el('threadTitle');
    const threadMetaEl = el('threadMeta');
    const inputEl = el('input');

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function render() {
      renderProvider();
      renderThreads();
      renderMessages();
      renderRefs();
      threadMetaEl.textContent = state.snapshot.session
        ? state.snapshot.session.branch + ' · ' + state.snapshot.participantCount + ' collaborator(s)'
        : 'No active session';
    }

    function renderProvider() {
      const status = state.providerStatus;
      providerLineEl.textContent = status
        ? status.activeProvider + ' · ' + status.activeModel + ' · ' + (status.hasKey ? 'key saved' : 'no key')
        : 'Provider unavailable';
      providerEl.innerHTML = ['anthropic', 'openai', 'groq', 'ollama']
        .map((name) => '<option value="' + name + '" ' + (status && status.activeProvider === name ? 'selected' : '') + '>' + name + '</option>')
        .join('');
      modelEl.value = status?.activeModel || '';
      ollamaUrlEl.value = status?.ollamaUrl || '';
    }

    function renderThreads() {
      threadsEl.innerHTML = (state.threads || [])
        .map((thread) => {
          return (
            '<div class="thread ' +
            (thread.id === state.activeThreadId ? 'active' : '') +
            '" data-thread-id="' +
            thread.id +
            '">' +
            '<div><strong>' +
            escapeHtml(thread.name || thread.type) +
            '</strong></div>' +
            '<div class="small">' +
            escapeHtml(thread.id) +
            '</div>' +
            '</div>'
          );
        })
        .join('') || '<div class="small">No threads yet.</div>';
    }

    function renderMessages() {
      const messages = state.messages || [];
      threadTitleEl.textContent = state.threads.find((t) => t.id === state.activeThreadId)?.name || state.activeThreadId || 'No thread selected';
      messagesEl.innerHTML = messages.map((message) => {
        const diffs = Array.isArray(message.fileDiffs) ? message.fileDiffs : [];
        const steps = Array.isArray(message.agentSteps) ? message.agentSteps : [];
        const diffHtml = diffs.length
          ? '<div class="context">' +
            diffs.map((diff) => '<div><strong>' + escapeHtml(diff.filePath) + '</strong></div>').join('') +
            '</div>'
          : '';
        const stepHtml = steps.length
          ? '<div class="context">' +
            steps.map((step) => '<div><strong>' + escapeHtml(step.type) + '</strong> ' + escapeHtml(step.title) + '</div>').join('') +
            '</div>'
          : '';
        const approved = message.reviewed ? '<div class="small">' + escapeHtml(message.reviewed) + '</div>' : '';
        const hasReviewActions = Boolean(diffs.length || stepHtml);
        return (
          '<div class="msg ' +
          message.role +
          '">' +
          '<div class="msg-meta">' +
          '<span>' +
          escapeHtml(message.role) +
          '</span>' +
          '<span>' +
          escapeHtml(message.model || '') +
          '</span>' +
          '</div>' +
          '<div>' +
          escapeHtml(message.content || '') +
          '</div>' +
          stepHtml +
          diffHtml +
          approved +
          (hasReviewActions
            ? '<div class="msg-actions">' +
              '<button class="secondary" data-action="approveEdit" data-file-path="' +
              escapeHtml((diffs[0] && diffs[0].filePath) || '') +
              '" data-message-id="' +
              message.id +
              '">Approve</button>' +
              '<button class="secondary" data-action="rejectEdit" data-file-path="' +
              escapeHtml((diffs[0] && diffs[0].filePath) || '') +
              '" data-message-id="' +
              message.id +
              '">Reject</button>' +
              '</div>'
            : '') +
          '</div>'
        );
      }).join('') || '<div class="small">No messages yet.</div>';
    }

    function renderRefs() {
      refsEl.innerHTML = (state.contextRefs || [])
        .map((ref) => '<div class="pill"><span class="dot"></span>' + escapeHtml(ref.filePath) + ':' + ref.startLine + '-' + ref.endLine + '</div>')
        .join('') || '<div class="small">No refs.</div>';
    }

    threadsEl.addEventListener('click', (event) => {
      const item = event.target.closest('[data-thread-id]');
      if (!item) return;
      vscode.postMessage({ type: 'switchThread', threadId: item.dataset.threadId });
    });

    el('send').addEventListener('click', () => {
      vscode.postMessage({ type: 'send', content: inputEl.value, threadId: state.activeThreadId || undefined, mode: 'chat' });
      inputEl.value = '';
    });
    el('sendAgent').addEventListener('click', () => {
      vscode.postMessage({ type: 'send', content: inputEl.value, threadId: state.activeThreadId || undefined, mode: 'agent' });
      inputEl.value = '';
    });
    el('newThread').addEventListener('click', () => vscode.postMessage({ type: 'createThread' }));
    el('forkThread').addEventListener('click', () => {
      const last = state.messages[state.messages.length - 1];
      if (last) vscode.postMessage({ type: 'forkThread', messageId: last.id });
    });
    el('reloadHistory').addEventListener('click', () => vscode.postMessage({ type: 'loadHistory', threadId: state.activeThreadId || undefined }));
    el('saveProvider').addEventListener('click', () => {
      vscode.postMessage({ type: 'setProvider', provider: providerEl.value, model: modelEl.value, ollamaUrl: ollamaUrlEl.value });
    });
    messagesEl.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const payload = { key: target.dataset.key, filePath: target.dataset.filePath, messageId: target.dataset.messageId };
      vscode.postMessage({ type: target.dataset.action, ...payload });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.type) return;
      switch (message.type) {
        case 'init':
          Object.assign(state, message.state);
          render();
          break;
        case 'threadList':
          state.threads = message.threads;
          state.activeThreadId = message.activeThreadId;
          render();
          break;
        case 'messageAdded':
          state.messages = [...state.messages, message.message];
          renderMessages();
          break;
        case 'messageChunk': {
          let msg = state.messages.find((entry) => entry.id === message.messageId);
          if (!msg) {
            msg = { id: message.messageId, threadId: message.threadId, role: 'assistant', content: '', createdBy: 'assistant', createdAt: new Date().toISOString() };
            state.messages = [...state.messages, msg];
          }
          msg.content = (msg.content || '') + message.chunk;
          renderMessages();
          break;
        }
        case 'messageUpdated': {
          const idx = state.messages.findIndex((entry) => entry.id === message.message.id);
          if (idx >= 0) state.messages[idx] = message.message;
          else state.messages = [...state.messages, message.message];
          renderMessages();
          break;
        }
        case 'providerStatus':
          state.providerStatus = message.status;
          renderProvider();
          break;
        case 'safetyBlock':
          alert('File locked: ' + message.block.peerName + ' is editing ' + message.block.filePath);
          break;
        case 'step':
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }
}
