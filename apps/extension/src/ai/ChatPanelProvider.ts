import * as vscode from 'vscode';
import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';

import type { ChatThread, ChatMessage, AgentStep, SafetyBlock } from '@conduit/shared-types';
import { LLMRouter } from '@conduit/ai-core';
import type { ILLMProvider } from '@conduit/ai-core';

import type { BroadcastHub, CollaborationEvent, CollaborationSnapshot } from '../broadcast.js';
import type { AuthService } from '../AuthService.js';
import type { ApiKeyStore } from './ApiKeyStore.js';
import { IntentRouter } from './IntentRouter.js';
import { ContextAssembler } from './ContextAssembler.js';
import { AgentTools } from '../agent/AgentTools.js';
import { AgentExecutor } from '../agent/AgentExecutor.js';
import type { AgentPauseResult } from '../agent/AgentExecutor.js';
import type { ImageAttachment } from '@conduit/ai-core';
import { AgentSafetyLock } from '../agent/AgentSafetyLock.js';
import { ConduitWebSocketClient } from '../wsClient.js';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

type WebviewIncoming =
  | { type: 'ready' }
  | { type: 'send'; content: string; mode: 'ask' | 'agent'; threadId: string; images?: ImageAttachment[] }
  | { type: 'setMode'; mode: 'ask' | 'agent' }
  | { type: 'setOllamaUrl'; url: string }
  | { type: 'setModel'; provider: string; model: string }
  | { type: 'setProvider'; provider: string }
  | { type: 'getProviderStatus' }
  | { type: 'newThread' }
  | { type: 'fork'; messageId: string; kind: 'private' | 'public'; name?: string }
  | { type: 'selectThread'; threadId: string }
  | { type: 'approveStep'; stepId: string; messageId: string }
  | { type: 'rejectStep'; stepId: string; messageId: string }
  | { type: 'safetyContinue'; action: 'wait' | 'proceed' | 'skip'; token: string }
  | { type: 'rollback' }
  | { type: 'stopStream' }
  | { type: 'insertAtCursor'; code: string }
  | { type: 'replaceSelection'; code: string }
  | { type: 'pinFile'; path: string }
  | { type: 'unpinFile'; path: string }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'deleteThread'; threadId: string }
  | { type: 'pauseAgent' }
  | { type: 'resumeAgent'; content: string }
  | { type: 'abortAgent' }
  | { type: 'openDiff'; stepId: string; messageId: string }
  | { type: 'checkVisionSupport' }
  | { type: 'setApiKey'; provider: string; key: string };

type WebviewOutgoing =
  | { type: 'init'; threads: ChatThread[]; activeThreadId: string; messages: ChatMessage[]; snapshot: CollaborationSnapshot; providerStatus: ProviderStatus; mode: 'ask' | 'agent'; pinnedFiles: string[]; tokenBudget?: number; currentUser?: { id: string; email: string | undefined } | undefined; cooldownUser?: string | null; cooldownUserName?: string | null }
  | { type: 'threadCreated'; thread: ChatThread; messages: ChatMessage[]; threads?: ChatThread[] }
  | { type: 'threadSelected'; thread: ChatThread; messages: ChatMessage[]; threads?: ChatThread[] }
  | { type: 'messageAdded'; message: ChatMessage }
  | { type: 'messageUpdated'; message: ChatMessage }
  | { type: 'messageChunk'; messageId: string; chunk: string }
  | { type: 'messageDone'; messageId: string; totalTokens: number; model: string }
  | { type: 'agentStepUpdate'; messageId: string; step: AgentStep }
  | { type: 'sessionChanged'; snapshot: CollaborationSnapshot }
  | { type: 'providerStatus'; status: ProviderStatus }
  | { type: 'safetyBlock'; token: string; block: SafetyBlock }
  | { type: 'planApproval'; planId: string; plan: string[] }
  | { type: 'error'; message: string }
  | { type: 'pinnedFilesChanged'; pinnedFiles: string[] }
  | { type: 'contextTokens'; count: number }
  | { type: 'agentPaused'; messageId: string }
  | { type: 'agentResumed'; messageId: string }
  | { type: 'visionSupport'; supported: boolean }
  | { type: 'aiStatusChanged'; executingUser: string | null; executingUserName: string | null };

interface ProviderStatus {
  activeProvider: string;
  activeModel: string;
  hasKey: boolean;
  tokenBudget: number;
  providers: {
    name: string;
    hasKey: boolean;
    models: string[];
    activeModel: string;
  }[];
}

/**
 * The main AI panel WebviewViewProvider.
 * Handles all chat, streaming, agent loop, and Yjs sync for group threads.
 */
export class ChatPanelProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = 'conduit.aiPanel';

  private readonly disposables: vscode.Disposable[] = [];
  private readonly assembler = new ContextAssembler();
  private readonly router = new LLMRouter();

  private view: vscode.WebviewView | undefined;
  private snapshot: CollaborationSnapshot = {
    room: undefined, session: undefined, roomId: undefined,
    websocketUrl: undefined, state: 'disconnected',
    participantCount: 0, collaborators: [], lastError: undefined,
  };

  // In-memory thread/message store (persisted to Supabase via backend in session mode)
  // In-memory thread/message store (persisted to Supabase via backend in session mode)
  private threads: ChatThread[] = [];
  private messagesByThread = new Map<string, ChatMessage[]>();
  private activeThreadId: string | null = null;
  private mode: 'ask' | 'agent' = 'ask';
  private pinnedFiles: string[] = [];
  private activeStreamsByThread = new Set<string>();
  private askAbortController: AbortController | null = null;

  // Safety lock pending resolution map: token → resolver
  private safetyResolvers = new Map<string, (action: 'wait' | 'proceed' | 'skip') => void>();
  private planResolvers = new Map<string, (approved: boolean) => void>();
  private agentAbortController: AbortController | null = null;
  private activeExecutor: AgentExecutor | null = null;
  private agentPausedMessageId: string | null = null;

  private activeDocListener: Y.Doc | undefined = undefined;

  private aiStatusObserver = (event: Y.YMapEvent<any>) => {
    const activeDoc = this.wsClient.getActiveDoc();
    if (!activeDoc) return;
    const aiStatusMap = activeDoc.getMap<any>('ai-status');
    const executingUser = aiStatusMap.get('executingUser');
    this.post({
      type: 'aiStatusChanged',
      executingUser: executingUser?.id ?? null,
      executingUserName: executingUser?.name ?? null
    });
  };

  private chatArrayObserver = (event: Y.YArrayEvent<string>) => {
    const activeDoc = this.wsClient.getActiveDoc();
    if (!activeDoc) return;
    const chatArray = activeDoc.getArray<string>('chat-messages');
    
    const messages = chatArray.toArray().map((str: string) => {
      try { return JSON.parse(str) as ChatMessage; } catch { return null; }
    }).filter((m: ChatMessage | null): m is ChatMessage => m !== null);

    let changed = false;
    for (const msg of messages) {
      const msgs = this.messagesByThread.get(msg.threadId) ?? [];
      const idx = msgs.findIndex(m => m.id === msg.id);
      if (idx === -1) {
        this.messagesByThread.set(msg.threadId, [...msgs, msg]);
        if (msg.threadId === this.activeThreadId) {
          this.post({ type: 'messageAdded', message: msg });
        }
        changed = true;
      } else {
        const existing = msgs[idx]!;
        if (
          existing.content !== msg.content ||
          existing.tokensUsed !== msg.tokensUsed ||
          existing.model !== msg.model ||
          JSON.stringify(existing.agentSteps) !== JSON.stringify(msg.agentSteps)
        ) {
          const newMsgs = [...msgs];
          newMsgs[idx] = msg;
          this.messagesByThread.set(msg.threadId, newMsgs);
          if (msg.threadId === this.activeThreadId) {
            this.post({ type: 'messageUpdated', message: msg });
          }
          changed = true;
        }
      }
    }
  };

  private threadsArrayObserver = (event: Y.YArrayEvent<string>) => {
    const activeDoc = this.wsClient.getActiveDoc();
    if (!activeDoc) return;
    const threadsArray = activeDoc.getArray<string>('chat-threads');
    
    const yjsThreads = threadsArray.toArray().map((str: string) => {
      try { return JSON.parse(str) as ChatThread; } catch { return null; }
    }).filter((t: ChatThread | null): t is ChatThread => t !== null);

    for (const t of yjsThreads) {
      if (!this.threads.some(x => x.id === t.id)) {
        this.threads.push(t);
        this.messagesByThread.set(t.id, []);
        this.post({
          type: 'threadCreated',
          thread: t,
          messages: [],
          threads: this.threads,
        });
      }
    }
  };

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly broadcastHub: BroadcastHub,
    private readonly authService: AuthService,
    private readonly apiKeyStore: ApiKeyStore,
    private readonly wsClient: ConduitWebSocketClient
  ) {
    this.pinnedFiles = this.context.workspaceState.get<string[]>('conduit.pinnedFiles', []);
    this.mode = this.context.globalState.get<'ask' | 'agent'>('conduit.mode', 'ask');
    this.disposables.push(
      this.broadcastHub.onDidBroadcast((event: CollaborationEvent) => {
        void this.handleBroadcastEvent(event);
      })
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg: WebviewIncoming) => {
        void this.handleMessage(msg);
      }),
      webviewView.onDidDispose(() => { this.view = undefined; })
    );
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  // ----------------------------------------------------------------
  // Broadcast hub handler
  // ----------------------------------------------------------------
  private async handleBroadcastEvent(event: CollaborationEvent): Promise<void> {
    if (event.type === 'log') return;
    const prevSnapshot = this.snapshot;
    this.snapshot = event.snapshot;

    // Auto-create group thread when a session becomes active
    if (
      event.snapshot.state === 'connected' &&
      event.snapshot.session?.id &&
      prevSnapshot.state !== 'connected'
    ) {
      await this.ensureGroupThread(event.snapshot.session.id);
      this.subscribeToYjsChat();
    } else if (event.snapshot.state !== 'connected' && prevSnapshot.state === 'connected') {
      this.unsubscribeFromYjsChat();
      await this.loadStandaloneThreads();
    }

    this.post({ type: 'sessionChanged', snapshot: this.snapshot });
  }

  private subscribeToYjsChat(): void {
    this.unsubscribeFromYjsChat();
    const activeDoc = this.wsClient.getActiveDoc();
    if (!activeDoc) return;
    
    const chatArray = activeDoc.getArray<string>('chat-messages');
    chatArray.observe(this.chatArrayObserver);
    
    const threadsArray = activeDoc.getArray<string>('chat-threads');
    threadsArray.observe(this.threadsArrayObserver);

    const aiStatusMap = activeDoc.getMap<any>('ai-status');
    aiStatusMap.observe(this.aiStatusObserver);
    
    this.activeDocListener = activeDoc;
    
    // Load initial messages from Yjs if they aren't loaded locally
    const messages = chatArray.toArray().map((str: string) => {
      try { return JSON.parse(str) as ChatMessage; } catch { return null; }
    }).filter((m: ChatMessage | null): m is ChatMessage => m !== null);
    
    for (const msg of messages) {
      const msgs = this.messagesByThread.get(msg.threadId) ?? [];
      if (!msgs.some(m => m.id === msg.id)) {
        this.messagesByThread.set(msg.threadId, [...msgs, msg]);
      }
    }

    // Load initial threads from Yjs if they aren't loaded locally
    const yjsThreads = threadsArray.toArray().map((str: string) => {
      try { return JSON.parse(str) as ChatThread; } catch { return null; }
    }).filter((t: ChatThread | null): t is ChatThread => t !== null);
    
    let threadsChanged = false;
    for (const t of yjsThreads) {
      if (!this.threads.some(x => x.id === t.id)) {
        this.threads.push(t);
        this.messagesByThread.set(t.id, []);
        threadsChanged = true;
      }
    }
    
    if (threadsChanged) {
      const activeId = this.activeThreadId ?? this.threads[0]?.id;
      if (activeId) {
        this.post({
          type: 'threadSelected',
          thread: this.threads.find(x => x.id === activeId)!,
          messages: this.messagesByThread.get(activeId) ?? [],
          threads: this.threads,
        });
      }
    }
  }

  private unsubscribeFromYjsChat(): void {
    if (this.activeDocListener) {
      try {
        const chatArray = this.activeDocListener.getArray<string>('chat-messages');
        chatArray.unobserve(this.chatArrayObserver);
      } catch {}
      try {
        const threadsArray = this.activeDocListener.getArray<string>('chat-threads');
        threadsArray.unobserve(this.threadsArrayObserver);
      } catch {}
      try {
        const aiStatusMap = this.activeDocListener.getMap<any>('ai-status');
        aiStatusMap.unobserve(this.aiStatusObserver);
      } catch {}
      this.activeDocListener = undefined;
    }
    this.post({
      type: 'aiStatusChanged',
      executingUser: null,
      executingUserName: null
    });
  }

  private async apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const auth = await this.authService.getState();
    const baseUrl = this.authService.backendUrl;
    const headers = new Headers(options.headers);
    if (auth.accessToken) {
      headers.set('Authorization', `Bearer ${auth.accessToken}`);
    }
    headers.set('Content-Type', 'application/json');
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as any;
      throw new Error(body.error ?? `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  // ----------------------------------------------------------------
  // Webview message handler
  // ----------------------------------------------------------------
  private async handleMessage(msg: WebviewIncoming): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
        break;

      case 'send':
        await this.handleSend(msg.content, msg.mode, msg.threadId, msg.images);
        break;

      case 'setMode':
        this.mode = msg.mode;
        void this.context.globalState.update('conduit.mode', this.mode);
        break;

      case 'setApiKey': {
        const provider = msg.provider as Parameters<ApiKeyStore['setKey']>[0];
        const valid = await this.apiKeyStore.validateKey(provider, msg.key);
        if (valid) {
          await this.apiKeyStore.setKey(provider, msg.key);
          this.post({ type: 'providerStatus', status: await this.buildProviderStatus() });
        } else {
          this.post({ type: 'error', message: 'API key validation failed. Key not saved.' });
        }
        break;
      }

      case 'setOllamaUrl':
        await this.apiKeyStore.setOllamaUrl(msg.url);
        break;

      case 'setModel':
        await this.apiKeyStore.setModel(msg.provider as Parameters<ApiKeyStore['setModel']>[0], msg.model);
        this.post({ type: 'providerStatus', status: await this.buildProviderStatus() });
        break;

      case 'setProvider':
        await this.apiKeyStore.setActiveProvider(msg.provider as Parameters<ApiKeyStore['setActiveProvider']>[0]);
        this.post({ type: 'providerStatus', status: await this.buildProviderStatus() });
        break;

      case 'getProviderStatus':
        this.post({ type: 'providerStatus', status: await this.buildProviderStatus() });
        break;

      case 'newThread':
        await this.createNewThread();
        break;

      case 'fork':
        await this.forkThread(msg.messageId, msg.kind, msg.name);
        break;

      case 'selectThread': {
        const thread = this.threads.find((t) => t.id === msg.threadId);
        if (thread) {
          this.activeThreadId = thread.id;
          try {
            const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
              `/chat/threads/${thread.id}/messages`
            );
            this.messagesByThread.set(thread.id, messages);
          } catch (err) {
            console.warn('Failed to refresh messages from DB for thread:', thread.id, err);
          }
          this.post({
            type: 'threadSelected',
            thread,
            messages: this.messagesByThread.get(thread.id) ?? [],
          });
        }
        break;
      }

      case 'safetyContinue': {
        const resolver = this.safetyResolvers.get(msg.token);
        if (resolver) {
          resolver(msg.action);
          this.safetyResolvers.delete(msg.token);
        }
        break;
      }

      case 'deleteThread': {
        const threadId = msg.threadId;
        try {
          await this.apiFetch(`/chat/threads/${threadId}`, {
            method: 'DELETE',
          });
          
          this.threads = this.threads.filter((t) => t.id !== threadId);
          this.messagesByThread.delete(threadId);

          if (this.activeThreadId === threadId) {
            const groupThread = this.threads.find((t) => t.type === 'group');
            if (groupThread) {
              this.activeThreadId = groupThread.id;
            } else if (this.threads.length > 0) {
              this.activeThreadId = this.threads[0]!.id;
            } else {
              await this.createNewThread();
            }
          }

          const activeThread = this.threads.find((t) => t.id === this.activeThreadId);
          const activeId = this.activeThreadId as string;
          if (activeThread) {
            try {
              const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
                `/chat/threads/${activeId}/messages`
              );
              this.messagesByThread.set(activeId, messages);
            } catch (err) {
              console.warn('Failed to refresh messages for active thread after deletion:', err);
            }
            this.post({
              type: 'threadSelected',
              thread: activeThread,
              messages: this.messagesByThread.get(activeId) ?? [],
              threads: this.threads,
            });
          } else {
            const authState = await this.authService.getState();
            this.post({
              type: 'init',
              threads: this.threads,
              activeThreadId: '',
              messages: [],
              snapshot: this.snapshot,
              providerStatus: await this.buildProviderStatus(),
              mode: this.mode,
              pinnedFiles: this.pinnedFiles,
              tokenBudget: this.getTokenBudget(),
              currentUser: authState.user ? { id: authState.user.id, email: authState.user.email } : undefined,
            });
          }
        } catch (err) {
          console.error('Failed to delete thread:', err);
          this.post({
            type: 'error',
            message: `Failed to delete chat thread: ${err instanceof Error ? err.message : String(err)}`
          });
        }
        break;
      }

      case 'approveStep':
      case 'rejectStep': {
        const planId = msg.messageId;
        const resolver = this.planResolvers.get(planId);
        if (resolver) {
          resolver(msg.type === 'approveStep');
          this.planResolvers.delete(planId);
        }
        break;
      }

      case 'abortAgent': {
        // Fast path: kill the agent immediately without going through the LLM classifier.
        // Resume with new_task so the waitForResume() promise resolves (in case the
        // executor is currently suspended at a pause point), then fire the abort signal
        // so the running loop also exits if it is mid-iteration.
        if (this.activeExecutor?.isPaused) {
          this.activeExecutor.resume({ action: 'new_task' });
        }
        if (this.agentAbortController) {
          this.agentAbortController.abort();
        }
        break;
      }

      case 'rollback':
        // Legacy rollback-only path (from agent step cards)
        if (this.agentAbortController) {
          this.agentAbortController.abort();
        }
        break;


      case 'pauseAgent':
        if (this.activeExecutor && !this.activeExecutor.isPaused) {
          this.activeExecutor.pause();
          if (this.agentPausedMessageId) {
            this.post({ type: 'agentPaused', messageId: this.agentPausedMessageId });
          }
        }
        break;

      case 'resumeAgent': {
        if (this.activeExecutor && this.activeExecutor.isPaused) {
          // Use an LLM call to classify the follow-up intent
          const pauseResult = await this.classifyPauseFollowUp(msg.content);
          this.activeExecutor.resume(pauseResult);
          if (this.agentPausedMessageId) {
            this.post({ type: 'agentResumed', messageId: this.agentPausedMessageId });
          }
          // If new_task, the executor will stop — handleSend will start fresh
          if (pauseResult.action === 'new_task' && this.activeThreadId) {
            await this.handleSend(msg.content, 'agent', this.activeThreadId);
          }
        }
        break;
      }

      case 'openDiff': {
        // Find the step with matching stepId in the message
        const msgs = this.messagesByThread.get(this.activeThreadId ?? '') ?? [];
        const targetMsg = msgs.find((m) => m.id === msg.messageId);
        const step = targetMsg?.agentSteps?.find((s) => s.id === msg.stepId);
        if (step?.diff) {
          await this.openDiffEditor(step.diff);
        }
        break;
      }

      case 'checkVisionSupport': {
        const provider = await this.getActiveProvider();
        const supported = provider ? await provider.checkVisionSupport() : false;
        this.post({ type: 'visionSupport', supported });
        break;
      }

      case 'stopStream':
        if (this.askAbortController) {
          this.askAbortController.abort();
        }
        break;

      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.text);
        break;

      case 'insertAtCursor': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const safetyLock = this.buildSafetyLock();
          const checkResult = safetyLock.check(editor.document.fileName);
          if (checkResult.blocked) {
            this.post({
              type: 'error',
              message: `File modified by ${checkResult.peerName || 'a teammate'} — review before inserting`
            });
            break;
          }
          await editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, msg.code);
          });
        }
        break;
      }

      case 'replaceSelection': {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          const safetyLock = this.buildSafetyLock();
          const checkResult = safetyLock.check(editor.document.fileName);
          if (checkResult.blocked) {
            this.post({
              type: 'error',
              message: `File modified by ${checkResult.peerName || 'a teammate'} — review before inserting`
            });
            break;
          }
          await editor.edit((editBuilder) => {
            editBuilder.replace(editor.selection, msg.code);
          });
        }
        break;
      }

      case 'pinFile':
        if (!this.pinnedFiles.includes(msg.path)) {
          this.pinnedFiles = [...this.pinnedFiles, msg.path];
          void this.context.workspaceState.update('conduit.pinnedFiles', this.pinnedFiles);
          this.post({ type: 'pinnedFilesChanged', pinnedFiles: this.pinnedFiles });
        }
        break;

      case 'unpinFile':
        this.pinnedFiles = this.pinnedFiles.filter((f) => f !== msg.path);
        void this.context.workspaceState.update('conduit.pinnedFiles', this.pinnedFiles);
        this.post({ type: 'pinnedFilesChanged', pinnedFiles: this.pinnedFiles });
        break;
    }
  }

  // ----------------------------------------------------------------
  // Core send handler
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Core send handler
  // ----------------------------------------------------------------
  private getTokenBudget(): number {
    const activeProvider = this.apiKeyStore.getActiveProvider();
    const model = this.apiKeyStore.getModel(activeProvider) ?? '';

    // Cloud model budgets
    const cloudBudgets: Record<string, number> = {
      'claude-opus-4': 150_000,
      'claude-sonnet-4': 80_000,
      'claude-haiku': 40_000,
      'gpt-4o': 80_000,
      'gpt-4-turbo': 80_000,
      'gpt-4': 60_000,
      'gpt-3.5': 14_000,
      'llama3-70b': 6_000,
      'mixtral-8x22': 40_000,
      'mixtral': 24_000,
    };

    // Ollama local model budgets — keep small to avoid slow inference
    // These map to a model's effective usable context window
    const ollamaBudgets: Record<string, number> = {
      'llama3.1:70b':  8_192,
      'llama3.1:8b':   4_096,
      'llama3.2:3b':   2_048,
      'llama3.2:1b':   2_048,
      'llama3.2':      4_096,
      'llama3.1':      4_096,
      'llama3:70b':    4_096,
      'llama3':        4_096,
      'llama2':        3_072,
      'mistral':       4_096,
      'mistral-nemo':  8_192,
      'codellama':     4_096,
      'deepseek-coder': 4_096,
      'deepseek-r1':   8_192,
      'phi3':          2_048,
      'phi':           2_048,
      'gemma':         4_096,
      'gemma2':        4_096,
      'qwen2.5':       8_192,
      'qwen2':         4_096,
      'starcoder2':    4_096,
      'codegemma':     4_096,
    };

    if (activeProvider === 'ollama') {
      // Check exact model match first
      for (const [key, budget] of Object.entries(ollamaBudgets)) {
        if (model === key || model.startsWith(key + ':') || model.startsWith(key + '-')) {
          return budget;
        }
      }
      // Substring match for unrecognised local models
      for (const [key, budget] of Object.entries(ollamaBudgets)) {
        if (model.includes(key.split(':')[0]!)) return budget;
      }
      return 4_096; // safe default for any unknown local model
    }

    for (const [key, budget] of Object.entries(cloudBudgets)) {
      if (model.includes(key)) return budget;
    }
    return 16_000; // safe default for cloud providers
  }

  private async handleSend(
    content: string,
    mode: 'ask' | 'agent',
    threadId: string,
    images?: ImageAttachment[]
  ): Promise<void> {
    if (this.activeStreamsByThread.has(threadId)) return;
    this.activeStreamsByThread.add(threadId);

    const activeDoc = this.wsClient.getActiveDoc();
    if (activeDoc) {
      const aiStatusMap = activeDoc.getMap<any>('ai-status');
      const executingUser = aiStatusMap.get('executingUser');
      const authState = await this.authService.getState();
      if (executingUser && executingUser.id !== authState.user?.id) {
        this.post({ type: 'error', message: 'An AI response is already in progress for another user. Please wait.' });
        this.activeStreamsByThread.delete(threadId);
        return;
      }
      const localUserId = authState.user?.id ?? 'anonymous';
      const localUserName = authState.user?.username ?? authState.user?.email ?? 'anonymous';
      aiStatusMap.set('executingUser', { id: localUserId, name: localUserName });
    }

    try {
      // Auto-detect intent if mode was not manually set
      const detectedMode = IntentRouter.classify(content);
      const effectiveMode = mode === 'ask' && detectedMode === 'agent' ? 'agent' : mode;

      const provider = await this.getActiveProvider();
      if (!provider) {
        // No key — show inline message
        const authState = await this.authService.getState();
        const noKeyMsg = this.makeMessage(threadId, 'assistant',
          '⚠️ **No API key configured.** Open the ⚙️ settings in this panel to add your Anthropic, OpenAI, Groq, or Ollama key.',
          authState.user?.id ?? 'system'
        );
        this.addMessage(threadId, noKeyMsg);
        this.post({ type: 'messageAdded', message: noKeyMsg });
        return;
      }

      const authState = await this.authService.getState();
      const senderId = authState.user?.id ?? 'anonymous';

      // Build lightweight attachment metadata from any attached files (no raw data stored)
      const attachmentMetas = images && images.length > 0
        ? images.map((img) => ({
            fileName: img.fileName ?? 'file',
            mimeType: img.mimeType,
            size: img.size ?? 0,
          }))
        : undefined;

      // Add user message (with attachment metadata for history display)
      const userMsg = this.makeMessage(threadId, 'user', content, senderId, undefined, attachmentMetas);
      this.addMessage(threadId, userMsg);
      this.post({ type: 'messageAdded', message: userMsg });

      // Save user message to database (attachments stored as JSONB metadata, not raw data)
      try {
        await this.apiFetch(`/chat/threads/${threadId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            id: userMsg.id,
            role: 'user',
            content: userMsg.content,
            attachments: attachmentMetas,
          }),
        });
      } catch (err) {
        console.error('Failed to save user message to DB:', err);
      }

      // Push user message to Yjs array
      if (activeDoc) {
        const chatArray = activeDoc.getArray<string>('chat-messages');
        chatArray.push([JSON.stringify(userMsg)]);
      }

      // Assemble context
      const thread = this.threads.find((t) => t.id === threadId);
      if (!thread) {
        this.post({ type: 'error', message: 'Thread not found. Please refresh.' });
        return;
      }
      const messages = this.messagesByThread.get(threadId) ?? [];

      const tokenBudget = this.getTokenBudget();
      const assembled = await this.assembler.assemble({
        thread,
        messages,
        userInput: content,
        pinnedFiles: this.pinnedFiles,
        activeFile: vscode.window.activeTextEditor
          ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
          : undefined,
        cursorLine: vscode.window.activeTextEditor?.selection.active.line,
        peers: this.snapshot.collaborators ?? [],
        tokenBudget,
        mode: effectiveMode,
      });

      this.post({ type: 'contextTokens', count: assembled.totalTokens });

      if (effectiveMode === 'ask') {
        await this.runAsk(threadId, assembled, provider, senderId, images);
      } else {
        await this.runAgent(threadId, content, assembled, provider, senderId, images);
      }
    } finally {
      this.activeStreamsByThread.delete(threadId);
      if (activeDoc) {
        const aiStatusMap = activeDoc.getMap<any>('ai-status');
        const executingUser = aiStatusMap.get('executingUser');
        const authState = await this.authService.getState();
        if (executingUser && executingUser.id === authState.user?.id) {
          aiStatusMap.delete('executingUser');
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // Ask mode — streaming response
  // ----------------------------------------------------------------
  private async runAsk(
    threadId: string,
    context: import('./ContextAssembler.js').AssembledContext,
    provider: ILLMProvider,
    senderId: string,
    images?: ImageAttachment[]
  ): Promise<void> {
    const msgId = this.generateId();
    const placeholder = this.makeMessage(threadId, 'assistant', '', senderId, msgId);
    this.addMessage(threadId, placeholder);
    this.post({ type: 'messageAdded', message: placeholder });

    // Save assistant placeholder message to database
    try {
      await this.apiFetch(`/chat/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          id: msgId,
          role: 'assistant',
          content: '',
          model: provider.modelId,
        }),
      });
    } catch (err) {
      console.error('Failed to save assistant placeholder message to DB:', err);
    }

    this.askAbortController = new AbortController();
    const abortSignal = this.askAbortController.signal;
    let fullContent = '';
    let totalTokens = 0;

    try {
      const result = await provider.streamChat(
        [...context.conversationHistory].map((m, i, arr) => {
          // Attach images to the last user message
          if (images && images.length > 0 && m.role === 'user' && i === arr.length - 1) {
            return { ...m, images };
          }
          return m;
        }),
        context.systemPrompt,
        (chunk) => {
          if (abortSignal.aborted) return;
          fullContent += chunk;
          this.post({ type: 'messageChunk', messageId: msgId, chunk });
        },
        abortSignal  // ← pass signal so providers can cancel the HTTP stream immediately
      );
      totalTokens = result.totalTokens;

      if (abortSignal.aborted) {
        // Stream was stopped by user — commit whatever was received so far
        const partialMsg: ChatMessage = {
          ...placeholder,
          content: fullContent || '_(stopped)_',
          tokensUsed: totalTokens,
          model: provider.modelId,
        };
        this.updateMessage(threadId, msgId, partialMsg);
        this.post({ type: 'messageDone', messageId: msgId, totalTokens, model: provider.modelId });
        return;
      }

      // Update message with final content + refs
      const finalMsg: ChatMessage = {
        ...placeholder,
        content: fullContent,
        tokensUsed: totalTokens,
        model: provider.modelId,
        contextRefs: context.refs as ChatMessage['contextRefs'],
      };
      this.updateMessage(threadId, msgId, finalMsg);
      this.post({ type: 'messageDone', messageId: msgId, totalTokens, model: provider.modelId });

      // Save assistant message to database
      try {
        await this.apiFetch(`/chat/threads/${threadId}/messages/${msgId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            content: finalMsg.content,
            tokensUsed: finalMsg.tokensUsed,
          }),
        });
      } catch (err) {
        console.error('Failed to update assistant message in DB:', err);
      }

      // Push assistant message to Yjs array
      const activeDoc = this.wsClient.getActiveDoc();
      if (activeDoc) {
        const chatArray = activeDoc.getArray<string>('chat-messages');
        chatArray.push([JSON.stringify(finalMsg)]);
      }
    } catch (err) {
      const errorContent = `❌ ${err instanceof Error ? err.message : 'An error occurred.'}`;
      const errMsg: ChatMessage = { ...placeholder, content: errorContent };
      this.updateMessage(threadId, msgId, errMsg);
      this.post({ type: 'messageDone', messageId: msgId, totalTokens: 0, model: provider.modelId });

      // Save error message to database
      try {
        await this.apiFetch(`/chat/threads/${threadId}/messages/${msgId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            content: errMsg.content,
          }),
        });
      } catch (e) {
        console.error('Failed to update error message in DB:', e);
      }

      // Push error message to Yjs array
      const activeDoc = this.wsClient.getActiveDoc();
      if (activeDoc) {
        const chatArray = activeDoc.getArray<string>('chat-messages');
        chatArray.push([JSON.stringify(errMsg)]);
      }
    } finally {
      this.askAbortController = null;
    }
  }

  // ----------------------------------------------------------------
  // Agent mode — full loop
  // ----------------------------------------------------------------
  private async runAgent(
    threadId: string,
    goal: string,
    context: import('./ContextAssembler.js').AssembledContext,
    provider: ILLMProvider,
    senderId: string,
    images?: ImageAttachment[]
  ): Promise<void> {
    const msgId = this.generateId();
    const placeholder = this.makeMessage(threadId, 'assistant', '🤖 Agent starting…', senderId, msgId);
    this.addMessage(threadId, placeholder);
    this.post({ type: 'messageAdded', message: placeholder });

    // Save agent placeholder to DB
    try {
      await this.apiFetch(`/chat/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          id: msgId,
          role: 'assistant',
          content: '🤖 Agent starting…',
          model: provider.modelId,
        }),
      });
    } catch (err) {
      console.error('Failed to save agent placeholder to DB:', err);
    }

    // Build safety lock (requires Yjs awareness — may not be available outside session)
    // We resolve it lazily — if no awareness, all safety checks return blocked=false
    const safetyLock = this.buildSafetyLock();
    const tools = new AgentTools(
      safetyLock,
      async (block: SafetyBlock) => {
        const token = this.generateId();
        this.post({ type: 'safetyBlock', token, block });
        return new Promise<'wait' | 'proceed' | 'skip'>((resolve) => {
          this.safetyResolvers.set(token, resolve);
          // Auto-skip after 30s if user doesn't respond
          setTimeout(() => {
            if (this.safetyResolvers.has(token)) {
              this.safetyResolvers.delete(token);
              resolve('skip');
            }
          }, 30_000);
        });
      }
    );

    const executor = new AgentExecutor(
      tools,
      provider,
      (step: AgentStep) => {
        this.post({ type: 'agentStepUpdate', messageId: msgId, step });
      }
    );

    this.agentAbortController = new AbortController();
    this.activeExecutor = executor;
    this.agentPausedMessageId = msgId;

    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) {
      this.post({ type: 'error', message: 'Thread not found. Please refresh.' });
      return;
    }
    const messages = this.messagesByThread.get(threadId) ?? [];

    const result = await executor.execute(
      goal,
      {
        assembler: this.assembler,
        assembleOpts: {
          thread,
          messages,
          userInput: goal,
          pinnedFiles: this.pinnedFiles,
          activeFile: vscode.window.activeTextEditor
            ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
            : undefined,
          cursorLine: vscode.window.activeTextEditor?.selection.active.line,
          peers: this.snapshot.collaborators ?? [],
          tokenBudget: this.getTokenBudget(),
          mode: 'agent',
        },
        preAssembled: context,
        images: images ?? [],
      },
      this.agentAbortController.signal
    );

    const finalContent = result.success
      ? `✅ Task complete.\n\n${result.error ?? ''}`
      : `⚠️ Agent stopped: ${result.error ?? 'Unknown error'}`;

    const finalMsg: ChatMessage = {
      ...placeholder,
      content: finalContent,
      agentSteps: result.stepsCompleted,
    };
    this.updateMessage(threadId, msgId, finalMsg);
    this.post({ type: 'messageDone', messageId: msgId, totalTokens: result.totalTokens, model: provider.modelId });

    // Save agent message to database
    try {
      await this.apiFetch(`/chat/threads/${threadId}/messages/${msgId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          content: finalMsg.content,
          agentSteps: finalMsg.agentSteps,
          tokensUsed: result.totalTokens,
        }),
      });
    } catch (err) {
      console.error('Failed to save agent message to DB:', err);
    }

    // Push agent message to Yjs array
    const activeDoc = this.wsClient.getActiveDoc();
    if (activeDoc) {
      const chatArray = activeDoc.getArray<string>('chat-messages');
      chatArray.push([JSON.stringify(finalMsg)]);
    }

    this.agentAbortController = null;
    this.activeExecutor = null;
    this.agentPausedMessageId = null;
  }
  // ----------------------------------------------------------------
  private async ensureGroupThread(sessionId: string): Promise<void> {
    const existing = this.threads.find(
      (t) => t.sessionId === sessionId && t.type === 'group'
    );
    if (existing) {
      this.activeThreadId = existing.id;
      try {
        const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
          `/chat/threads/${existing.id}/messages`
        );
        this.messagesByThread.set(existing.id, messages);
        this.post({
          type: 'threadSelected',
          thread: existing,
          messages,
          threads: this.threads,
        });
      } catch (err) {
        console.warn('Failed to refresh messages for existing group thread:', existing.id, err);
        this.post({
          type: 'threadSelected',
          thread: existing,
          messages: this.messagesByThread.get(existing.id) ?? [],
          threads: this.threads,
        });
      }
      return;
    }

    // Try to load group thread and messages from DB
    try {
      const { threads } = await this.apiFetch<{ threads: ChatThread[] }>(
        `/chat/threads?sessionId=${sessionId}`
      );
      
      this.threads = threads;
      const groupThread = threads.find(t => t.type === 'group' && t.sessionId === sessionId);
      if (groupThread) {
        this.activeThreadId = groupThread.id;
        
        const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
          `/chat/threads/${groupThread.id}/messages`
        );
        this.messagesByThread.set(groupThread.id, messages);

        const activeDoc = this.wsClient.getActiveDoc();
        if (activeDoc) {
          const threadsArray = activeDoc.getArray<string>('chat-threads');
          const exists = threadsArray.toArray().some(str => {
            try { return (JSON.parse(str) as ChatThread).id === groupThread.id; } catch { return false; }
          });
          if (!exists) {
            threadsArray.push([JSON.stringify(groupThread)]);
          }
        }
        
        this.post({ type: 'threadSelected', thread: groupThread, messages, threads: this.threads });
        return;
      }
    } catch (err) {
      console.warn('Failed to load group thread from DB, falling back to local creation:', err);
    }

    const authState = await this.authService.getState();
    const deterministicId = sessionId;
    let thread: ChatThread = {
      id: deterministicId,
      sessionId,
      type: 'group',
      name: undefined,
      forkedFromMessageId: undefined,
      createdBy: authState.user?.id ?? 'anonymous',
      createdAt: new Date().toISOString(),
    };

    try {
      const res = await this.apiFetch<{ thread: ChatThread }>('/chat/threads', {
        method: 'POST',
        body: JSON.stringify({
          id: deterministicId,
          sessionId,
          type: 'group',
        }),
      });
      thread = res.thread;
    } catch (err) {
      console.error('Failed to save group thread to DB:', err);
    }

    this.threads = [thread];
    this.messagesByThread.set(thread.id, []);
    this.activeThreadId = thread.id;

    const activeDoc = this.wsClient.getActiveDoc();
    if (activeDoc) {
      const threadsArray = activeDoc.getArray<string>('chat-threads');
      const exists = threadsArray.toArray().some(str => {
        try { return (JSON.parse(str) as ChatThread).id === thread.id; } catch { return false; }
      });
      if (!exists) {
        threadsArray.push([JSON.stringify(thread)]);
      }
    }

    this.post({ type: 'threadCreated', thread, messages: [], threads: this.threads });
  }

  private async createNewThread(): Promise<void> {
    const authState = await this.authService.getState();
    const tempId = this.generateId();
    let thread: ChatThread = {
      id: tempId,
      sessionId: this.snapshot.session?.id,
      type: 'standalone',
      name: undefined,
      forkedFromMessageId: undefined,
      createdBy: authState.user?.id ?? 'anonymous',
      createdAt: new Date().toISOString(),
    };

    try {
      const res = await this.apiFetch<{ thread: ChatThread }>('/chat/threads', {
        method: 'POST',
        body: JSON.stringify({
          id: tempId,
          sessionId: this.snapshot.session?.id,
          type: 'standalone',
        }),
      });
      thread = res.thread;
    } catch (err) {
      console.error('Failed to save standalone thread to DB:', err);
    }

    this.threads.push(thread);
    this.messagesByThread.set(thread.id, []);
    this.activeThreadId = thread.id;
    this.post({ type: 'threadCreated', thread, messages: [], threads: this.threads });
  }

  private async loadStandaloneThreads(): Promise<void> {
    try {
      const { threads } = await this.apiFetch<{ threads: ChatThread[] }>('/chat/threads');
      this.threads = threads;

      if (this.threads.length === 0) {
        await this.createNewThread();
        return;
      }

      const activeId = this.threads[0]!.id;
      this.activeThreadId = activeId;

      const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
        `/chat/threads/${activeId}/messages`
      );
      this.messagesByThread.set(activeId, messages);

      this.post({
        type: 'threadSelected',
        thread: this.threads[0]!,
        messages,
        threads: this.threads,
      });
    } catch (err) {
      console.warn('Failed to load standalone threads:', err);
    }
  }

  private async forkThread(
    messageId: string,
    kind: 'private' | 'public',
    name?: string
  ): Promise<void> {
    const authState = await this.authService.getState();
    const tempId = this.generateId();
    let thread: ChatThread = {
      id: tempId,
      sessionId: this.snapshot.session?.id,
      type: kind === 'private' ? 'private-fork' : 'public-fork',
      name,
      forkedFromMessageId: messageId,
      createdBy: authState.user?.id ?? 'anonymous',
      createdAt: new Date().toISOString(),
    };

    try {
      const res = await this.apiFetch<{ thread: ChatThread }>('/chat/threads', {
        method: 'POST',
        body: JSON.stringify({
          id: tempId,
          sessionId: this.snapshot.session?.id,
          type: kind === 'private' ? 'private-fork' : 'public-fork',
          name,
          forkedFromMessageId: messageId,
        }),
      });
      thread = res.thread;
    } catch (err) {
      console.error('Failed to save fork thread to DB:', err);
      this.post({
        type: 'error',
        message: `Failed to create fork thread in database: ${err instanceof Error ? err.message : String(err)}`
      });
      return;
    }

    // Copy messages up to the forked message
    const sourceMessages: ChatMessage[] = [];
    for (const msgs of this.messagesByThread.values()) {
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        sourceMessages.push(...msgs.slice(0, idx + 1));
        break;
      }
    }

    const forkedMessages = sourceMessages.map((m) => ({ ...m, id: this.generateId(), threadId: thread.id }));
    
    for (const msg of forkedMessages) {
      try {
        await this.apiFetch(`/chat/threads/${thread.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            id: msg.id,
            role: msg.role,
            content: msg.content,
          }),
        });
      } catch (err) {
        console.error('Failed to save forked message copy to DB:', err);
        this.post({
          type: 'error',
          message: `Failed to copy message to fork thread in database: ${err instanceof Error ? err.message : String(err)}`
        });
        return;
      }
    }

    this.threads.push(thread);
    this.messagesByThread.set(thread.id, forkedMessages);
    this.activeThreadId = thread.id;

    if (kind === 'public') {
      const activeDoc = this.wsClient.getActiveDoc();
      if (activeDoc) {
        const threadsArray = activeDoc.getArray<string>('chat-threads');
        threadsArray.push([JSON.stringify(thread)]);
      }
    }

    this.post({ type: 'threadCreated', thread, messages: forkedMessages, threads: this.threads });
  }

  // ----------------------------------------------------------------
  // Provider helpers
  // ----------------------------------------------------------------
  private async getActiveProvider(): Promise<ILLMProvider | null> {
    const providerName = this.apiKeyStore.getActiveProvider();
    const hasKey = await this.apiKeyStore.hasKey(providerName);
    if (!hasKey) return null;

    const apiKey = (await this.apiKeyStore.getKey(providerName)) ?? '';
    const modelId =
      this.apiKeyStore.getModel(providerName) ??
      this.router.getDefaultModelForProvider(providerName);

    return this.router.getProvider({
      provider: providerName,
      apiKey,
      modelId,
      ollamaUrl: this.apiKeyStore.getOllamaUrl(),
      contextWindow: this.getTokenBudget(),
    });
  }

  private async buildProviderStatus(): Promise<ProviderStatus> {
    const activeProvider = this.apiKeyStore.getActiveProvider();
    const providerNames = ['anthropic', 'openai', 'groq', 'ollama'] as const;

    const providers = await Promise.all(
      providerNames.map(async (name) => {
        const hasKey = await this.apiKeyStore.hasKey(name);
        const activeModel =
          this.apiKeyStore.getModel(name) ??
          this.router.getDefaultModelForProvider(name);

        let models: string[] = [];
        if (hasKey) {
          try {
            const key = (await this.apiKeyStore.getKey(name)) ?? '';
            const p = this.router.getProvider({
              provider: name,
              apiKey: key,
              modelId: activeModel,
              ollamaUrl: this.apiKeyStore.getOllamaUrl(),
              contextWindow: 4_096, // minimal for model listing only
            });
            models = await p.listModels();
          } catch {
            models = [];
          }
        }

        return { name, hasKey, models, activeModel };
      })
    );

    const activeEntry = providers.find((p) => p.name === activeProvider);
    return {
      activeProvider,
      activeModel: activeEntry?.activeModel ?? '',
      hasKey: activeEntry?.hasKey ?? false,
      tokenBudget: this.getTokenBudget(),
      providers,
    };
  }

  private buildSafetyLock(): AgentSafetyLock {
    const awareness = this.wsClient.getActiveAwareness();
    if (awareness) {
      return new AgentSafetyLock(awareness);
    }
    // No-op awareness shim — used when not in a collaborative session
    const noopAwareness = {
      clientID: -1,
      getStates: (): Map<number, Record<string, unknown>> => new Map(),
    };

    return new AgentSafetyLock(noopAwareness as unknown as import('y-protocols/awareness').Awareness);
  }

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------
  private async sendInit(): Promise<void> {
    const authState = await this.authService.getState();
    // Load threads and messages from database
    try {
      const sessionId = this.snapshot.session?.id;
      let url = '/chat/threads';
      if (sessionId) {
        url += `?sessionId=${sessionId}`;
      }
      const { threads } = await this.apiFetch<{ threads: ChatThread[] }>(url);
      
      for (const t of threads) {
        if (!this.threads.some(x => x.id === t.id)) {
          this.threads.push(t);
          this.messagesByThread.set(t.id, []);
        }
      }
      
      await Promise.all(
        threads.map(async (t) => {
          const { messages } = await this.apiFetch<{ messages: ChatMessage[] }>(
            `/chat/threads/${t.id}/messages`
          );
          this.messagesByThread.set(t.id, messages);
        })
      );
    } catch (err) {
      console.warn('Failed to load chat history from DB:', err);
    }

    // Ensure at least one thread exists
    if (this.threads.length === 0) {
      await this.createNewThread();
    }
    const activeDoc = this.wsClient.getActiveDoc();
    let executingUserId: string | null = null;
    let executingUserName: string | null = null;
    if (activeDoc) {
      const aiStatusMap = activeDoc.getMap<any>('ai-status');
      const executingUser = aiStatusMap.get('executingUser');
      if (executingUser) {
        executingUserId = executingUser.id;
        executingUserName = executingUser.name;
      }
    }

    const activeId = this.activeThreadId ?? this.threads[0]!.id;
    this.post({
      type: 'init',
      threads: this.threads,
      activeThreadId: activeId,
      messages: this.messagesByThread.get(activeId) ?? [],
      snapshot: this.snapshot,
      providerStatus: await this.buildProviderStatus(),
      mode: this.mode,
      pinnedFiles: this.pinnedFiles,
      currentUser: authState.user ? { id: authState.user.id, email: authState.user.email } : undefined,
      cooldownUser: executingUserId,
      cooldownUserName: executingUserName,
    });

    if (this.snapshot.state === 'connected') {
      this.subscribeToYjsChat();
    }
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  private makeMessage(
    threadId: string,
    role: 'user' | 'assistant',
    content: string,
    senderId: string,
    id?: string,
    attachments?: import('@conduit/shared-types').AttachmentMeta[]
  ): ChatMessage {
    return {
      id: id ?? this.generateId(),
      threadId,
      role,
      content,
      model: undefined,
      tokensUsed: undefined,
      contextRefs: undefined,
      agentSteps: undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      senderId,
      createdAt: new Date().toISOString(),
    };
  }

  private addMessage(threadId: string, message: ChatMessage): void {
    const msgs = this.messagesByThread.get(threadId) ?? [];
    this.messagesByThread.set(threadId, [...msgs, message]);
  }

  private updateMessage(threadId: string, msgId: string, updated: ChatMessage): void {
    const msgs = this.messagesByThread.get(threadId) ?? [];
    const idx = msgs.findIndex((m) => m.id === msgId);
    if (idx !== -1) {
      const newMsgs = [...msgs];
      newMsgs[idx] = updated;
      this.messagesByThread.set(threadId, newMsgs);
    }
  }

  private generateId(): string {
    return randomUUID();
  }

  private post(message: WebviewOutgoing): void {
    void this.view?.webview.postMessage(message);
  }

  // ----------------------------------------------------------------
  // HTML — React 18 + Babel standalone (no bundler needed)
  // ----------------------------  // ----------------------------------------------------------------
  // HTML — Pure Vanilla JS (No CDN dependencies, no Babel, offline-first)
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Pause follow-up classifier (LLM call)
  // ----------------------------------------------------------------
  private async classifyPauseFollowUp(content: string): Promise<AgentPauseResult> {
    try {
      const provider = await this.getActiveProvider();
      if (!provider) return { action: 'continue', additionalContext: content };

      let fullResponse = '';
      await provider.streamChat(
        [{ role: 'user', content: `User message after pausing an AI coding agent:\n"${content}"\n\nClassify intent. Reply with ONLY one of:\nCONTINUE\nNEW_TASK` }],
        'You are an intent classifier. Given a user message sent after pausing an AI coding agent mid-task, decide: should the agent CONTINUE the current task (possibly with added context), or did the user start a NEW_TASK that is unrelated to the current one? Respond with exactly CONTINUE or NEW_TASK.',
        (chunk) => { fullResponse += chunk; }
      );

      const trimmed = fullResponse.trim().toUpperCase();
      if (trimmed.includes('NEW_TASK')) {
        return { action: 'new_task' };
      }
      return { action: 'continue', additionalContext: content };
    } catch {
      // On failure, default to continue — safer than aborting
      return { action: 'continue', additionalContext: content };
    }
  }

  // ----------------------------------------------------------------
  // Diff editor
  // ----------------------------------------------------------------
  private async openDiffEditor(diff: import('@conduit/shared-types').FileDiff): Promise<void> {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const absPath = path.join(root, diff.filePath);

      // Read current (after-edit) content from disk
      const afterContent = await fs.readFile(absPath, 'utf-8').catch(() => '');

      // Reconstruct before-content from the diff hunks
      const afterLines = afterContent.split('\n');
      const beforeLines: string[] = [];
      for (const hunk of diff.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'del' || line.type === 'ctx') {
            beforeLines.push(line.content);
          }
        }
      }
      const beforeContent = beforeLines.join('\n');

      // Write before-content to a temp file
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, `conduit-before-${Date.now()}-${path.basename(diff.filePath)}`);
      await fs.writeFile(tmpFile, beforeContent, 'utf-8');

      const beforeUri = vscode.Uri.file(tmpFile);
      const afterUri = vscode.Uri.file(absPath);
      const title = `${path.basename(diff.filePath)}: Before ↔ After (Agent Edit)`;

      await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
    } catch (err) {
      console.error('openDiffEditor failed:', err);
    }
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const fontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "fonts", "Arima-font.ttf")
    );
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com data:`,
      `script-src 'nonce-${nonce}'`,
      `connect-src 'none'`,
      `img-src data: vscode-resource:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Conduit Copilot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    @font-face {
      font-family: 'Arima';
      src: url('${fontUri}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --surface: var(--vscode-editor-background, #252526);
      --surface2: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
      --border: var(--vscode-panel-border, #3c3c3c);
      --fg: var(--vscode-foreground, #cccccc);
      --fg2: var(--vscode-descriptionForeground, #858585);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --focus: var(--vscode-focusBorder, #007acc);
      --error: var(--vscode-errorForeground, #f48771);
      --green: var(--vscode-terminal-ansiGreen, #89d185);
      --yellow: var(--vscode-charts-yellow, #cca700);
      --font: 'Arima', 'Inter', var(--vscode-font-family, sans-serif);
      --mono: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      --radius: 8px;
    }
    html, body { height: 100%; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 13px; line-height: 1.5; overflow: hidden; }
    #app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

    /* Header */
    .app-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
    .app-title { font-size: 13px; font-weight: 600; flex: 1; }
    .session-pill { font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); color: var(--fg2); text-transform: capitalize; }
    #btn-new-thread, #btn-toggle-settings { font-size: 16px; padding: 2px 6px; border-radius: 4px; color: var(--fg2); cursor: pointer; border: none; background: none; }
    #btn-toggle-settings { font-size: 14px; transition: transform 0.2s; }
    #btn-toggle-settings.active { transform: rotate(45deg); }

    /* Settings Drawer */
    .settings-drawer { padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--surface); overflow-y: auto; max-height: 360px; flex-shrink: 0; }
    .settings-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .settings-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg2); }
    .settings-close { font-size: 16px; color: var(--fg2); padding: 0 4px; cursor: pointer; border: none; background: none; }
    .provider-row { margin-bottom: 16px; }
    .provider-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .provider-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid var(--border); text-transform: capitalize; cursor: pointer; user-select: none; }
    .provider-badge.active { background: var(--accent); color: var(--accent-fg); }
    .provider-status-text { font-size: 10px; color: var(--green); }
    .provider-input-group { display: flex; gap: 6px; }
    .provider-input-group input { flex: 1; font-size: 12px; font: inherit; color: var(--fg); background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; outline: none; }
    .provider-input-group input:focus { border-color: var(--focus); }
    .provider-input-group button { padding: 4px 10px; border-radius: 6px; font-size: 12px; background: var(--accent); color: var(--accent-fg); border: none; cursor: pointer; }
    .provider-input-group button.saved { background: var(--green); color: #000; }
    .provider-model-select { margin-top: 6px; width: 100%; font-size: 12px; padding: 4px 6px; border-radius: 4px; background: var(--surface2); color: var(--fg); border: 1px solid var(--border); outline: none; }

    /* Warning Banner */
    .warning-banner { padding: 8px 12px; background: rgba(204,167,0,0.1); border-bottom: 1px solid var(--yellow); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .warning-text { font-size: 12px; color: var(--yellow); flex: 1; }
    #btn-setup-warning { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--yellow); color: #000; font-weight: 600; border: none; cursor: pointer; }

    /* Pinned Files Bar */
    .pinned-files-bar { display: flex; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; flex-shrink: 0; background: var(--surface); }
    .pinned-file-badge { display: flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); font-size: 11px; color: var(--fg2); }
    .pinned-file-remove { font-size: 12px; color: var(--fg2); cursor: pointer; border: none; background: none; line-height: 1; }

    /* Chat History */
    .chat-history { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; }
    .empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--fg2); gap: 8px; }
    .empty-icon { font-size: 32px; }
    .empty-text { font-size: 13px; text-align: center; max-width: 240px; }

    /* Message Bubble */
    .msg-bubble-container { display: flex; flex-direction: column; margin-bottom: 12px; position: relative; }
    .msg-bubble-container.user { align-items: flex-end; }
    .msg-bubble-container.assistant { align-items: flex-start; }
    .msg-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .msg-sender { font-size: 10px; color: var(--fg2); }
    .msg-model { font-size: 9px; color: var(--fg2); opacity: 0.6; }
    .msg-time { font-size: 10px; color: var(--fg2); }
    .msg-bubble { max-width: 94%; padding: 9px 12px; border-radius: 12px; position: relative; }
    .msg-bubble-container.user .msg-bubble { background: var(--accent); color: var(--accent-fg); border-radius: 12px 12px 4px 12px; }
    .msg-bubble-container.assistant .msg-bubble { background: var(--surface); border: 1px solid var(--border); color: var(--fg); border-radius: 4px 12px 12px 12px; }
    .msg-thinking { color: var(--fg2); font-style: italic; font-size: 12px; }

    /* Fork Options Overlay */
    .fork-overlay { display: none; position: absolute; top: -8px; right: 8px; gap: 4px; z-index: 10; }
    .msg-bubble-container.assistant:hover .fork-overlay { display: flex; }
    .fork-btn { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); color: var(--fg2); cursor: pointer; }

    /* Context Badge Container */
    .context-refs-container { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; max-width: 94%; }
    .context-ref-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--surface2); border: 1px solid var(--border); color: var(--fg2); }

    /* Markdown & CodeBlock */
    .code-block-container { position: relative; margin: 8px 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
    .code-block-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px; background: var(--surface2); font-size: 11px; color: var(--fg2); }
    .code-block-actions { display: flex; gap: 6px; }
    .code-block-actions button { font-size: 11px; color: var(--fg2); padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; background: transparent; }
    .code-block-pre { margin: 0; padding: 10px 12px; overflow-x: auto; background: var(--surface); font-family: var(--mono); font-size: 12px; line-height: 1.6; }

    /* Agent Step Cards */
    .agent-step-card { margin-top: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); width: 100%; }
    .agent-step-header { display: flex; align-items: center; gap: 8px; }
    .agent-step-title { flex: 1; font-weight: 500; font-size: 12px; }
    .agent-step-status { font-size: 10px; padding: 1px 6px; border-radius: 8px; color: #fff; font-weight: 600; text-transform: capitalize; }
    .agent-step-status.pending { background: var(--yellow); }
    .agent-step-status.running { background: var(--accent); }
    .agent-step-status.done { background: var(--green); color: #000; }
    .agent-step-status.approved { background: var(--green); color: #000; }
    .agent-step-status.rejected { background: var(--error); }
    .agent-step-body { margin-top: 6px; font-size: 11px; color: var(--fg2); white-space: pre-wrap; }
    .agent-step-safety { margin-top: 8px; padding: 8px; border-radius: 4px; background: rgba(204,167,0,0.1); border: 1px solid var(--yellow); }
    .agent-step-safety-text { font-size: 12px; color: var(--yellow); }
    .agent-step-actions { display: flex; gap: 8px; margin-top: 8px; }
    .agent-step-actions button { padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 12px; border: none; cursor: pointer; }
    .agent-step-actions .btn-approve { background: var(--green); color: #000; }
    .agent-step-actions .btn-reject { background: var(--error); color: #fff; }

    /* Diff View */
    .diff-view { margin-top: 8px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); font-size: 12px; font-family: var(--mono); }
    .diff-file-path { padding: 4px 10px; background: var(--surface2); color: var(--fg2); font-size: 11px; }
    .diff-line { padding: 1px 10px; display: flex; }
    .diff-line.add { background: rgba(137,209,133,0.12); color: var(--green); border-left: 2px solid var(--green); }
    .diff-line.del { background: rgba(244,135,113,0.12); color: var(--error); border-left: 2px solid var(--error); }
    .diff-line.ctx { border-left: 2px solid transparent; }
    .diff-indicator { user-select: none; margin-right: 8px; opacity: 0.5; width: 10px; display: inline-block; }

    /* Input Area */
    .input-area { border-top: 1px solid var(--border); padding: 8px 10px; background: var(--surface); flex-shrink: 0; }
    .input-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .mode-toggle { display: flex; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; font-size: 11px; }
    .mode-toggle button { padding: 3px 12px; font-weight: 600; text-transform: capitalize; border: none; background: transparent; color: var(--fg2); cursor: pointer; transition: background 0.15s; }
    .mode-toggle button.active { background: var(--accent); color: var(--accent-fg); }
    .input-meta .model-pill { font-size: 11px; color: var(--fg2); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface2); text-transform: capitalize; }
    .input-meta .token-count { margin-left: auto; font-size: 10px; color: var(--fg2); }
    .input-meta .token-count.warning { color: var(--error); }
    .input-wrapper { display: flex; gap: 8px; align-items: flex-end; }
    .input-wrapper textarea { font: inherit; font-size: 12px; line-height: 1.5; color: var(--fg); background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; width: 100%; outline: none; resize: none; min-height: 44px; max-height: 120px; overflow-y: auto; }
    .input-wrapper textarea:focus { border-color: var(--focus); }
    .btn-send { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-fg); font-size: 16px; flex-shrink: 0; border: none; cursor: pointer; transition: all 0.15s; }
    .btn-send:disabled { opacity: 0.4; cursor: default; }
    .btn-send.stop { background: var(--error); }
    .btn-pause { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--surface2); color: var(--fg); font-size: 14px; flex-shrink: 0; border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
    .btn-pause:hover { border-color: var(--focus); }
    .btn-attach { width: 30px; height: 30px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: transparent; color: var(--fg2); font-size: 14px; flex-shrink: 0; border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
    .btn-attach:hover { border-color: var(--focus); color: var(--fg); }
    .btn-attach.has-images { border-color: var(--accent); color: var(--accent); }
    .attachment-preview { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0 2px 0; }
    .attachment-chip { position: relative; display: inline-flex; align-items: center; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; max-width: 120px; min-width: 48px; }
    .attachment-chip img { width: 64px; height: 48px; object-fit: cover; display: block; flex-shrink: 0; }
    .attachment-chip .remove-img { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; background: rgba(0,0,0,0.6); color: #fff; font-size: 10px; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; flex-shrink: 0; z-index: 1; }
    .attachment-chip .file-chip-inner { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 6px 8px 6px 6px; min-width: 52px; max-width: 110px; }
    .attachment-chip .file-chip-icon { font-size: 18px; line-height: 1; }
    .attachment-chip .file-chip-label { font-size: 9px; color: var(--fg2); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
    .attachment-chip .file-chip-size { font-size: 8px; color: var(--fg3, var(--fg2)); opacity: 0.7; text-align: center; }
    .chat-drop-overlay { display: none; position: absolute; inset: 0; z-index: 100; background: color-mix(in srgb, var(--accent) 12%, transparent); border: 2px dashed var(--accent); border-radius: 8px; align-items: center; justify-content: center; pointer-events: none; }
    .chat-drop-overlay.active { display: flex; }
    .chat-drop-overlay span { font-size: 15px; color: var(--accent); font-weight: 500; pointer-events: none; }
    .paused-banner { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: color-mix(in srgb, var(--warn, #f0a500) 15%, transparent); border-top: 1px solid color-mix(in srgb, var(--warn, #f0a500) 40%, transparent); font-size: 11px; color: var(--fg); flex-shrink: 0; }
    .paused-banner span { flex: 1; }
    .paused-banner button { font-size: 11px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface2); color: var(--fg); cursor: pointer; }
    .diff-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; transition: border-color 0.15s; margin-top: 4px; }
    .diff-chip:hover { border-color: var(--focus); }
    .diff-chip .adds { color: #4ec994; }
    .diff-chip .dels { color: #f14c4c; }
    .diff-chip .fname { color: var(--fg2); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-step-card.running .agent-step-title::after { content: ''; display: inline-block; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    /* Threads Drawer */
    .threads-drawer { padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--surface); overflow-y: auto; max-height: 240px; flex-shrink: 0; }
    .thread-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-radius: var(--radius); margin-bottom: 4px; cursor: pointer; background: var(--surface2); border: 1px solid transparent; }
    .thread-item:hover { border-color: var(--focus); }
    .thread-item.active { background: var(--accent); color: var(--accent-fg); }
    .thread-name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .thread-date { font-size: 10px; opacity: 0.6; margin-left: 8px; }
    .thread-delete-btn { font-size: 11px; padding: 1px 5px; border-radius: 4px; border: none; background: transparent; color: var(--fg2); cursor: pointer; opacity: 0; transition: opacity 0.15s; flex-shrink: 0; margin-left: 4px; }
    .thread-item:hover .thread-delete-btn { opacity: 1; }
    .thread-item.active .thread-delete-btn { color: var(--accent-fg); opacity: 0.7; }
    .thread-item.active .thread-delete-btn:hover { opacity: 1; }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="app" style="position:relative;">
    <!-- Header -->
    <header class="app-header">
      <span class="app-title">✦ Conduit Copilot</span>
      <span id="session-label" class="session-pill">Local</span>
      <button id="btn-toggle-threads" title="Chat History" style="font-size:14px; padding:2px 6px; border-radius:4px; color:var(--fg2); cursor:pointer; border:none; background:none;">🕰</button>
      <button id="btn-new-thread" title="New chat">＋</button>
      <button id="btn-toggle-settings" title="Settings">⚙</button>
    </header>

    <!-- Settings Drawer -->
    <div id="settings-drawer" class="settings-drawer hidden"></div>

    <!-- Threads Drawer -->
    <div id="threads-drawer" class="threads-drawer hidden"></div>

    <!-- Warning Banner -->
    <div id="warning-banner" class="warning-banner hidden">
      <span class="warning-text">⚠ No API key. Open ⚙ to add one.</span>
      <button id="btn-setup-warning">Setup</button>
    </div>

    <!-- Pinned Files Bar -->
    <div id="pinned-files-bar" class="pinned-files-bar hidden"></div>

    <!-- Chat History -->
    <div id="chat-history" class="chat-history"></div>

    <!-- Input Area -->
    <div class="input-area">
      <div class="input-meta">
        <div class="mode-toggle">
          <button id="btn-mode-ask" class="active">Ask</button>
          <button id="btn-mode-agent">Agent</button>
        </div>
        <span id="active-model-pill" class="model-pill hidden"></span>
        <span id="token-count" class="token-count">~0 tk</span>
      </div>
      <div id="attachment-preview" class="attachment-preview" style="display:none"></div>
      <div id="chat-drop-overlay" class="chat-drop-overlay"><span>📎 Drop files to attach</span></div>
      <div id="paused-banner" class="paused-banner" style="display:none">
        <span>⏸ Agent paused — type to continue or start a new task</span>
        <button id="btn-abort-agent">Abort</button>
      </div>
      <div class="input-wrapper">
        <textarea id="chat-input" rows="2" placeholder="Ask about your codebase…"></textarea>
        <input type="file" id="file-input" accept="*/*" multiple style="display:none">
        <button id="btn-attach" class="btn-attach" title="Attach file">📎</button>
        <button id="btn-pause" class="btn-pause hidden" title="Pause agent">⏸</button>
        <button id="btn-send" class="btn-send" disabled>↑</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const post = (msg) => vscode.postMessage(msg);

    const state = {
      threads: [],
      activeThreadId: null,
      messages: [],
      snapshot: null,
      providerStatus: null,
      mode: 'ask',
      pinnedFiles: [],
      streamingId: null,
      showSettings: false,
      showThreads: false,
      keys: {},
      ollamaUrl: 'http://localhost:11434',
      validating: {},
      saved: {},
      input: '',
      currentUser: null,
      contextTokens: 0,
      pendingImages: [],      // ImageAttachment[] staged for next send
      agentPaused: false,     // true while agent is suspended
      pausedMessageId: null,  // messageId of the paused agent message
      visionSupported: false, // set by checkVisionSupport response
      cooldownUser: null,
      cooldownUserName: null
    };

    // ── Helpers ──
    const formatTime = (isoString) => {
      try {
        const d = new Date(isoString);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        return '';
      }
    };

    const escapeHtml = (str) => {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };



    // ── CodeBlock Creator ──
    const createCodeBlock = (code, lang) => {
      const container = document.createElement('div');
      container.className = 'code-block-container';

      const header = document.createElement('div');
      header.className = 'code-block-header';
      
      const langSpan = document.createElement('span');
      langSpan.textContent = lang || 'code';
      header.appendChild(langSpan);

      const actions = document.createElement('div');
      actions.className = 'code-block-actions';

      const btnCopy = document.createElement('button');
      btnCopy.textContent = 'Copy';
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(code)
          .then(() => {
            btnCopy.textContent = '✓ Copied';
            setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
          })
          .catch(() => {
            post({ type: 'copyToClipboard', text: code });
            btnCopy.textContent = '✓ Copied';
            setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
          });
      });
      actions.appendChild(btnCopy);

      const btnInsert = document.createElement('button');
      btnInsert.textContent = 'Insert';
      btnInsert.addEventListener('click', () => {
        post({ type: 'insertAtCursor', code });
      });
      actions.appendChild(btnInsert);

      const btnReplace = document.createElement('button');
      btnReplace.textContent = 'Replace';
      btnReplace.addEventListener('click', () => {
        post({ type: 'replaceSelection', code });
      });
      actions.appendChild(btnReplace);

      header.appendChild(actions);
      container.appendChild(header);

      const pre = document.createElement('pre');
      pre.className = 'code-block-pre';
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.appendChild(codeEl);
      container.appendChild(pre);

      return container;
    };

    // ── Markdown Parser ──
    const renderMarkdown = (text, container) => {
      container.innerHTML = '';
      if (!text) return;

      const fenceRe = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
      let last = 0;
      let m;

      while ((m = fenceRe.exec(text)) !== null) {
        if (m.index > last) {
          const p = document.createElement('p');
          p.style.marginBottom = '6px';
          p.style.whiteSpace = 'pre-wrap';
          p.textContent = text.slice(last, m.index);
          container.appendChild(p);
        }

        const codeBlock = createCodeBlock(m[2], m[1]);
        container.appendChild(codeBlock);

        last = m.index + m[0].length;
      }

      if (last < text.length) {
        const p = document.createElement('p');
        p.style.marginBottom = '6px';
        p.style.whiteSpace = 'pre-wrap';
        p.textContent = text.slice(last);
        container.appendChild(p);
      }
    };

    const renderMarkdownSafe = (text, container) => {
      try {
        renderMarkdown(text, container);
      } catch (err) {
        console.error('Markdown rendering error:', err);
        container.innerHTML = '';
        const errorFallback = document.createElement('pre');
        errorFallback.style.whiteSpace = 'pre-wrap';
        errorFallback.style.color = 'var(--error)';
        errorFallback.textContent = text;
        container.appendChild(errorFallback);
      }
    };

    // ── DiffView Creator ──
    const createDiffView = (diff) => {
      const container = document.createElement('div');
      container.className = 'diff-view';

      const pathHeader = document.createElement('div');
      pathHeader.className = 'diff-file-path';
      pathHeader.textContent = diff.filePath;
      container.appendChild(pathHeader);

      if (diff.hunks) {
        diff.hunks.forEach((hunk) => {
          if (hunk.lines) {
            hunk.lines.forEach((line) => {
              const lineEl = document.createElement('div');
              lineEl.className = \`diff-line \${line.type}\`;

              const indicator = document.createElement('span');
              indicator.className = 'diff-indicator';
              indicator.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
              lineEl.appendChild(indicator);

              const contentSpan = document.createElement('span');
              contentSpan.textContent = line.content;
              lineEl.appendChild(contentSpan);

              container.appendChild(lineEl);
            });
          }
        });
      }

      return container;
    };

    // ── AgentStepCard Creator ──
    const createAgentStepCard = (step, messageId) => {
      const container = document.createElement('div');
      container.className = 'agent-step-card';

      const header = document.createElement('div');
      header.className = 'agent-step-header';

      const icons = { plan: '📋', read: '📖', edit: '✏️', 'safety-check': '🔒', verify: '🔬', done: '✅', error: '❌' };
      const iconSpan = document.createElement('span');
      iconSpan.textContent = icons[step.type] || '•';
      header.appendChild(iconSpan);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'agent-step-title';
      titleSpan.textContent = step.title;
      header.appendChild(titleSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = \`agent-step-status \${step.status}\`;
      statusSpan.textContent = step.status;
      header.appendChild(statusSpan);

      container.appendChild(header);

      if (step.body) {
        const bodyEl = document.createElement('p');
        bodyEl.className = 'agent-step-body';
        bodyEl.textContent = step.body;
        container.appendChild(bodyEl);
      }

      if (step.safetyBlock) {
        const safetyEl = document.createElement('div');
        safetyEl.className = 'agent-step-safety';
        const safetyText = document.createElement('p');
        safetyText.className = 'agent-step-safety-text';
        safetyText.innerHTML = \`🔒 <strong>\${escapeHtml(step.safetyBlock.peerName)}</strong> is editing <code>\${escapeHtml(step.safetyBlock.filePath)}</code>\`;
        safetyEl.appendChild(safetyText);
        container.appendChild(safetyEl);
      }

      if (step.diff) {
        // Count adds/dels for the chip
        let adds = 0, dels = 0;
        for (const hunk of step.diff.hunks || []) {
          for (const line of hunk.lines || []) {
            if (line.type === 'add') adds++;
            else if (line.type === 'del') dels++;
          }
        }
        const chip = document.createElement('button');
        chip.className = 'diff-chip';
        chip.title = 'Click to open diff viewer';
        chip.innerHTML = \`<span class="adds">+\${adds}</span><span class="dels">-\${dels}</span><span class="fname">\${escapeHtml(step.diff.filePath)}</span>\`;
        chip.addEventListener('click', () => {
          post({ type: 'openDiff', stepId: step.id, messageId });
        });
        container.appendChild(chip);

        // Also render inline diff (collapsed)
        const diffEl = createDiffView(step.diff);
        diffEl.style.display = 'none';
        chip.addEventListener('click', () => {
          // Toggle inline diff (in addition to opening VS Code diff)
          diffEl.style.display = diffEl.style.display === 'none' ? 'block' : 'none';
        });
        container.appendChild(diffEl);
      }

      if (step.type === 'plan' && step.status === 'pending') {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'agent-step-actions';

        const btnApprove = document.createElement('button');
        btnApprove.className = 'btn-approve';
        btnApprove.textContent = 'Approve Plan';
        btnApprove.addEventListener('click', () => {
          post({ type: 'approveStep', stepId: step.id, messageId });
        });
        actionsEl.appendChild(btnApprove);

        const btnReject = document.createElement('button');
        btnReject.className = 'btn-reject';
        btnReject.textContent = 'Reject';
        btnReject.addEventListener('click', () => {
          post({ type: 'rejectStep', stepId: step.id, messageId });
        });
        actionsEl.appendChild(btnReject);

        container.appendChild(actionsEl);
      }

      return container;
    };

    // ── MessageBubble Creator ──
    const createMessageBubble = (msg) => {
      const isUser = msg.role === 'user';
      
      const container = document.createElement('div');
      container.className = \`msg-bubble-container \${isUser ? 'user' : 'assistant'}\`;
      container.setAttribute('data-msg-id', msg.id);

      const meta = document.createElement('div');
      meta.className = 'msg-meta';

      const senderSpan = document.createElement('span');
      senderSpan.className = 'msg-sender';
      let displayName = '✦ Copilot';
      if (isUser) {
        if (state.currentUser && msg.senderId === state.currentUser.id) {
          displayName = 'You';
        } else {
          const collaborator = state.snapshot && state.snapshot.collaborators && state.snapshot.collaborators.find(c => c.userId === msg.senderId);
          displayName = collaborator ? collaborator.name : (msg.senderName || (msg.senderId ? msg.senderId.slice(0, 8) : 'Collaborator'));
        }
      }
      senderSpan.textContent = displayName;
      meta.appendChild(senderSpan);

      if (msg.model) {
        const modelSpan = document.createElement('span');
        modelSpan.className = 'msg-model';
        modelSpan.textContent = msg.model;
        meta.appendChild(modelSpan);
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      timeSpan.textContent = formatTime(msg.createdAt);
      meta.appendChild(timeSpan);

      container.appendChild(meta);

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      if (msg.content === '') {
        const thinkingSpan = document.createElement('span');
        thinkingSpan.className = 'msg-thinking';
        thinkingSpan.textContent = 'Thinking…';
        bubble.appendChild(thinkingSpan);
      } else {
        renderMarkdownSafe(msg.content, bubble);
      }

      // Show attachment chips for historical user messages (metadata only — no preview)
      if (isUser && msg.attachments && msg.attachments.length > 0) {
        const attachRow = document.createElement('div');
        attachRow.className = 'msg-attachments';
        attachRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
        msg.attachments.forEach((att) => {
          const chip = document.createElement('div');
          chip.className = 'attachment-chip';
          chip.title = att.fileName;
          const inner = document.createElement('div');
          inner.className = 'file-chip-inner';
          const ext = att.fileName.toLowerCase().split('.').pop() || '';
          const icon = document.createElement('span');
          icon.className = 'file-chip-icon';
          if (att.mimeType === 'application/pdf') icon.textContent = '📄';
          else if (att.mimeType.startsWith('image/')) icon.textContent = '🖼️';
          else if (['ts','tsx','js','jsx','mjs','json','yaml','yml'].includes(ext)) icon.textContent = '{ }';
          else if (ext === 'py') icon.textContent = '🐍';
          else if (['md','txt','rst'].includes(ext)) icon.textContent = '📝';
          else if (['html','css','scss'].includes(ext)) icon.textContent = '🌐';
          else if (['sql','graphql'].includes(ext)) icon.textContent = '🗃️';
          else icon.textContent = '📎';
          const label = document.createElement('span');
          label.className = 'file-chip-label';
          label.textContent = att.fileName;
          if (att.size) {
            const sizeEl = document.createElement('span');
            sizeEl.className = 'file-chip-size';
            const kb = att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size/1024).toFixed(1)+' KB' : (att.size/1048576).toFixed(1)+' MB';
            sizeEl.textContent = kb;
            inner.appendChild(icon);
            inner.appendChild(label);
            inner.appendChild(sizeEl);
          } else {
            inner.appendChild(icon);
            inner.appendChild(label);
          }
          chip.appendChild(inner);
          attachRow.appendChild(chip);
        });
        bubble.appendChild(attachRow);
      }

      if (msg.agentSteps && msg.agentSteps.length > 0) {
        msg.agentSteps.forEach((step) => {
          const card = createAgentStepCard(step, msg.id);
          bubble.appendChild(card);
        });
      }

      if (!isUser) {
        const forkOverlay = document.createElement('div');
        forkOverlay.className = 'fork-overlay';

        const btnPrivate = document.createElement('button');
        btnPrivate.className = 'fork-btn';
        btnPrivate.title = 'Fork private';
        btnPrivate.textContent = '⑃ private';
        btnPrivate.addEventListener('click', () => {
          post({ type: 'fork', messageId: msg.id, kind: 'private' });
        });
        forkOverlay.appendChild(btnPrivate);

        const btnPublic = document.createElement('button');
        btnPublic.className = 'fork-btn';
        btnPublic.title = 'Fork public';
        btnPublic.textContent = '⑃ public';
        btnPublic.addEventListener('click', () => {
          btnPrivate.style.display = 'none';
          btnPublic.style.display = 'none';
          
          const form = document.createElement('div');
          form.className = 'fork-form';
          form.style.display = 'flex';
          form.style.gap = '4px';
          form.style.alignItems = 'center';
          form.style.marginTop = '4px';

          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'fork-input';
          input.placeholder = 'Fork name…';
          input.style.fontSize = '11px';
          input.style.padding = '2px 6px';
          input.style.borderRadius = '4px';
          input.style.border = '1px solid var(--border)';
          input.style.background = 'var(--surface2)';
          input.style.color = 'var(--fg)';
          input.style.outline = 'none';

          const btnConfirm = document.createElement('button');
          btnConfirm.className = 'fork-btn confirm';
          btnConfirm.textContent = '✓';
          btnConfirm.style.padding = '2px 6px';
          btnConfirm.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const val = input.value.trim();
            if (val) {
              post({ type: 'fork', messageId: msg.id, kind: 'public', name: val });
            }
            form.remove();
            btnPrivate.style.display = '';
            btnPublic.style.display = '';
          });

          const btnCancel = document.createElement('button');
          btnCancel.className = 'fork-btn cancel';
          btnCancel.textContent = '✕';
          btnCancel.style.padding = '2px 6px';
          btnCancel.addEventListener('click', (ev) => {
            ev.stopPropagation();
            form.remove();
            btnPrivate.style.display = '';
            btnPublic.style.display = '';
          });

          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              btnConfirm.click();
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              btnCancel.click();
            }
          });

          form.appendChild(input);
          form.appendChild(btnConfirm);
          form.appendChild(btnCancel);
          forkOverlay.appendChild(form);
          input.focus();
        });
        forkOverlay.appendChild(btnPublic);

        bubble.appendChild(forkOverlay);
      }

      container.appendChild(bubble);

      if (!isUser && msg.contextRefs && msg.contextRefs.length > 0) {
        const refsContainer = document.createElement('div');
        refsContainer.className = 'context-refs-container';
        
        msg.contextRefs.forEach((ref) => {
          const badge = document.createElement('span');
          badge.className = 'context-ref-badge';
          const fileName = ref.filePath.split('/').pop();
          badge.textContent = \`\${fileName}:\${ref.startLine}\`;
          refsContainer.appendChild(badge);
        });

        container.appendChild(refsContainer);
      }

      return container;
    };

    // ── Update View Functions ──
    const updateHeader = () => {
      const sessionLabel = document.getElementById('session-label');
      if (!sessionLabel) return;

      const activeThread = state.threads.find(t => t.id === state.activeThreadId);
      const sessionActive = state.snapshot && state.snapshot.session && state.snapshot.session.id;

      let labelText = 'Local';
      if (sessionActive) {
        if (activeThread && activeThread.type === 'group') {
          labelText = '● Group';
        } else if (activeThread && activeThread.type) {
          labelText = activeThread.type.replace('-', ' ');
        } else {
          labelText = 'Chat';
        }
      }

      sessionLabel.textContent = labelText;
    };

    const updateWarning = () => {
      const banner = document.getElementById('warning-banner');
      if (!banner) return;

      const hasKey = state.providerStatus?.hasKey;
      if (!hasKey && !state.showSettings && !state.showThreads) {
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    };

    const updatePinnedFiles = () => {
      const bar = document.getElementById('pinned-files-bar');
      if (!bar) return;

      if (state.pinnedFiles && state.pinnedFiles.length > 0) {
        bar.classList.remove('hidden');
        bar.innerHTML = '';
        
        state.pinnedFiles.forEach((f) => {
          const badge = document.createElement('span');
          badge.className = 'pinned-file-badge';
          
          const text = document.createElement('span');
          text.textContent = \`📎 \${f.split('/').pop()}\`;
          badge.appendChild(text);

          const btnRemove = document.createElement('button');
          btnRemove.className = 'pinned-file-remove';
          btnRemove.textContent = '×';
          btnRemove.addEventListener('click', () => {
            post({ type: 'unpinFile', path: f });
          });
          badge.appendChild(btnRemove);

          bar.appendChild(badge);
        });
      } else {
        bar.classList.add('hidden');
      }
    };

    const updateThreadsDrawer = () => {
      const drawer = document.getElementById('threads-drawer');
      if (!drawer) return;

      drawer.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'settings-header';

      const title = document.createElement('span');
      title.className = 'settings-title';
      title.textContent = 'Chat History';
      header.appendChild(title);

      const btnClose = document.createElement('button');
      btnClose.className = 'settings-close';
      btnClose.textContent = '✕';
      btnClose.addEventListener('click', () => {
        state.showThreads = false;
        drawer.classList.add('hidden');
        document.getElementById('btn-toggle-threads').classList.remove('active');
        updateWarning();
      });
      header.appendChild(btnClose);

      drawer.appendChild(header);

      if (!state.threads || state.threads.length === 0) {
        const empty = document.createElement('div');
        empty.style.padding = '8px';
        empty.style.color = 'var(--fg2)';
        empty.style.textAlign = 'center';
        empty.textContent = 'No chat history yet.';
        drawer.appendChild(empty);
        return;
      }

      state.threads.forEach((t) => {
        const item = document.createElement('div');
        item.className = 'thread-item';
        if (t.id === state.activeThreadId) {
          item.classList.add('active');
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'thread-name';
        
        let typeLabel = t.type === 'group' ? '👥' : t.type === 'public-fork' ? '🌿' : t.type === 'private-fork' ? '🔒' : '💬';
        let label = t.name || (t.type === 'group' ? 'Group Chat' : t.type ? t.type.replace('-', ' ') : 'Local Chat');
        nameSpan.textContent = typeLabel + ' ' + label;
        item.appendChild(nameSpan);

        const dateSpan = document.createElement('span');
        dateSpan.className = 'thread-date';
        dateSpan.textContent = formatTime(t.createdAt);
        item.appendChild(dateSpan);

        // Delete button — group threads cannot be deleted (they're shared)
        const canDelete = t.type !== 'group';
        const btnDelete = document.createElement('button');
        btnDelete.className = 'thread-delete-btn';
        btnDelete.textContent = '🗑';
        btnDelete.title = canDelete ? 'Delete this chat' : 'Group chats cannot be deleted';
        btnDelete.disabled = !canDelete;
        btnDelete.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!canDelete) return;
          if (!confirm('Delete this chat thread? This cannot be undone.')) return;
          post({ type: 'deleteThread', threadId: t.id });
          // Optimistically close drawer
          state.showThreads = false;
          drawer.classList.add('hidden');
          document.getElementById('btn-toggle-threads').classList.remove('active');
        });
        item.appendChild(btnDelete);

        item.addEventListener('click', () => {
          post({ type: 'selectThread', threadId: t.id });
          state.showThreads = false;
          drawer.classList.add('hidden');
          document.getElementById('btn-toggle-threads').classList.remove('active');
        });

        drawer.appendChild(item);
      });
    };

    const updateSettingsDrawer = () => {
      const drawer = document.getElementById('settings-drawer');
      if (!drawer) return;

      drawer.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'settings-header';

      const title = document.createElement('span');
      title.className = 'settings-title';
      title.textContent = 'API Keys & Settings';
      header.appendChild(title);

      const btnClose = document.createElement('button');
      btnClose.className = 'settings-close';
      btnClose.textContent = '✕';
      btnClose.addEventListener('click', () => {
        state.showSettings = false;
        drawer.classList.add('hidden');
        document.getElementById('btn-toggle-settings').classList.remove('active');
        updateWarning();
      });
      header.appendChild(btnClose);

      drawer.appendChild(header);

      const status = state.providerStatus;
      const providers = status?.providers || [];

      providers.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'provider-row';

        const pHeader = document.createElement('div');
        pHeader.className = 'provider-header';

        const badge = document.createElement('span');
        badge.className = 'provider-badge';
        if (status && status.activeProvider === p.name) {
          badge.classList.add('active');
        }
        badge.innerHTML = \`\${p.hasKey ? '●' : '○'} \${p.name}\`;
        
        badge.addEventListener('click', () => {
          post({ type: 'setProvider', provider: p.name });
        });
        pHeader.appendChild(badge);

        if (p.hasKey) {
          const statusText = document.createElement('span');
          statusText.className = 'provider-status-text';
          statusText.textContent = '✓ connected';
          pHeader.appendChild(statusText);
        }

        row.appendChild(pHeader);

        const inputGroup = document.createElement('div');
        inputGroup.className = 'provider-input-group';

        if (p.name !== 'ollama') {
          const input = document.createElement('input');
          input.type = 'password';
          input.placeholder = p.hasKey ? '(key saved)' : \`Enter \${p.name} API key\`;
          input.id = \`input-key-\${p.name}\`;
          
          if (state.keys[p.name]) {
            input.value = state.keys[p.name];
          }
          input.addEventListener('input', (e) => {
            state.keys[p.name] = e.target.value;
          });

          const btnSave = document.createElement('button');
          btnSave.id = \`btn-save-\${p.name}\`;
          
          if (state.saved[p.name]) {
            btnSave.textContent = '✓';
            btnSave.classList.add('saved');
          } else if (state.validating[p.name]) {
            btnSave.textContent = '…';
          } else {
            btnSave.textContent = 'Save';
          }

          const triggerSave = () => {
            const val = input.value.trim();
            if (!val) return;
            state.validating[p.name] = true;
            updateSettingsDrawer();
            post({ type: 'setApiKey', provider: p.name, key: val });
            
            setTimeout(() => {
              state.validating[p.name] = false;
              state.saved[p.name] = true;
              state.keys[p.name] = '';
              updateSettingsDrawer();
              setTimeout(() => {
                state.saved[p.name] = false;
                updateSettingsDrawer();
              }, 2000);
            }, 1500);
          };

          btnSave.addEventListener('click', triggerSave);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') triggerSave();
          });

          inputGroup.appendChild(input);
          inputGroup.appendChild(btnSave);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = 'Ollama URL (http://localhost:11434)';
          input.value = state.ollamaUrl;
          input.addEventListener('input', (e) => {
            state.ollamaUrl = e.target.value;
          });

          const btnSet = document.createElement('button');
          btnSet.textContent = 'Set';
          btnSet.addEventListener('click', () => {
            post({ type: 'setOllamaUrl', url: state.ollamaUrl });
          });

          inputGroup.appendChild(input);
          inputGroup.appendChild(btnSet);
        }

        row.appendChild(inputGroup);

        if (p.hasKey && p.models && p.models.length > 0) {
          const select = document.createElement('select');
          select.className = 'provider-model-select';
          
          p.models.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (p.activeModel === m) {
              opt.selected = true;
            }
            select.appendChild(opt);
          });

          select.addEventListener('change', (e) => {
            post({ type: 'setModel', provider: p.name, model: e.target.value });
          });

          row.appendChild(select);
        }

        drawer.appendChild(row);
      });
    };

    const updateChatHistory = () => {
      const container = document.getElementById('chat-history');
      if (!container) return;

      container.innerHTML = '';

      if (!state.messages || state.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';

        const icon = document.createElement('div');
        icon.className = 'empty-icon';
        icon.textContent = '✦';
        empty.appendChild(icon);

        const text = document.createElement('p');
        text.className = 'empty-text';
        text.textContent = 'Ask anything about your codebase, or start a task in Agent mode.';
        empty.appendChild(text);

        container.appendChild(empty);
        return;
      }

      state.messages.forEach((msg) => {
        const bubble = createMessageBubble(msg);
        container.appendChild(bubble);
      });

      container.scrollTop = container.scrollHeight;
    };

    const updateInputArea = () => {
      const btnAsk = document.getElementById('btn-mode-ask');
      const btnAgent = document.getElementById('btn-mode-agent');
      if (state.mode === 'ask') {
        btnAsk.classList.add('active');
        btnAgent.classList.remove('active');
      } else {
        btnAsk.classList.remove('active');
        btnAgent.classList.add('active');
      }

      const modelPill = document.getElementById('active-model-pill');
      if (state.providerStatus && state.providerStatus.activeModel) {
        modelPill.classList.remove('hidden');
        const modelParts = state.providerStatus.activeModel.split('-');
        const shortenedModel = modelParts.slice(0, 2).join('-');
        modelPill.textContent = \`\${state.providerStatus.activeProvider} · \${shortenedModel}\`;
      } else {
        modelPill.classList.add('hidden');
      }

      const tokenCount = document.getElementById('token-count');
      const budget = (state.providerStatus && state.providerStatus.tokenBudget) ? state.providerStatus.tokenBudget : 16000;
      const displayTokens = state.contextTokens || Math.round(state.input.length / 4);
      
      const formatCount = (num) => {
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num;
      };

      tokenCount.textContent = \`\${formatCount(displayTokens)} / \${formatCount(budget)} tk\`;
      
      if (budget > 0 && displayTokens >= budget * 0.8) {
        tokenCount.classList.add('warning');
      } else {
        tokenCount.classList.remove('warning');
      }

      const btnSend = document.getElementById('btn-send');
      const btnPause = document.getElementById('btn-pause');
      const pausedBanner = document.getElementById('paused-banner');
      const btnAttach = document.getElementById('btn-attach');

      // Attach button — always visible; tooltip reflects vision capability
      if (btnAttach) {
        btnAttach.style.display = 'flex';
        btnAttach.classList.toggle('has-images', state.pendingImages.length > 0);
        btnAttach.title = state.visionSupported
          ? 'Attach image, PDF, or text file'
          : 'Attach PDF or text file (images need a vision-capable model)';
      }

      // Paused banner
      if (pausedBanner) {
        pausedBanner.style.display = state.agentPaused ? 'flex' : 'none';
      }

      if (state.streamingId) {
        btnSend.disabled = false;
        // If agent is running (not ask mode streaming), show pause too
        if (state.mode === 'agent' && !state.agentPaused) {
          btnPause.classList.remove('hidden');
          btnSend.textContent = '⬛';
          btnSend.classList.add('stop');
          btnSend.title = 'Stop agent';
        } else if (state.agentPaused) {
          btnPause.classList.add('hidden');
          btnSend.textContent = '▶';
          btnSend.classList.remove('stop');
          btnSend.title = 'Send follow-up / resume';
          btnSend.disabled = !state.input.trim();
        } else {
          // Ask mode streaming
          btnPause.classList.add('hidden');
          btnSend.textContent = '⬛';
          btnSend.classList.add('stop');
          btnSend.title = 'Stop streaming';
        }
      } else {
        btnPause.classList.add('hidden');
        btnSend.textContent = '↑';
        btnSend.classList.remove('stop');
        btnSend.title = 'Send message';
        const text = state.input.trim();
        btnSend.disabled = !text && state.pendingImages.length === 0;
      }

      const isCooldown = state.cooldownUser && state.cooldownUser !== (state.currentUser ? state.currentUser.id : null);
      if (isCooldown) {
        btnSend.disabled = true;
        btnSend.title = \`AI is busy responding to \${state.cooldownUserName || 'another user'}\`;
      }

      const textarea = document.getElementById('chat-input');
      textarea.disabled = !!(state.streamingId && !state.agentPaused) || !!isCooldown;
      if (isCooldown) {
        textarea.placeholder = \`AI is responding to \${state.cooldownUserName || 'another user'}...\`;
      } else {
        textarea.placeholder = state.mode === 'agent' 
          ? 'Describe a task… (Agent will plan + edit)' 
          : 'Ask about your codebase…';
      }
    };

    const sendMessage = () => {
      const textarea = document.getElementById('chat-input');
      const text = textarea.value.trim();

      // If agent is paused, send as resume
      if (state.agentPaused) {
        if (!text) return;
        post({ type: 'resumeAgent', content: text });
        state.input = '';
        textarea.value = '';
        textarea.style.height = 'auto';
        updateInputArea();
        return;
      }

      if (!text && state.pendingImages.length === 0) return;
      if (!state.activeThreadId) return;
      // Block new sends while streaming, UNLESS agent is paused (resume path)
      if (state.streamingId && !state.agentPaused) return;

      post({
        type: 'send',
        content: text,
        mode: state.mode,
        threadId: state.activeThreadId,
        images: state.pendingImages.length > 0 ? [...state.pendingImages] : undefined,
      });

      state.input = '';
      state.pendingImages = [];
      textarea.value = '';
      textarea.style.height = 'auto';
      document.getElementById('attachment-preview').style.display = 'none';
      updateInputArea();
    };

    // ── Attachment helpers ──
    const fileToBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // result is data:mime;base64,XXX — strip the prefix
        const result = reader.result;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const formatFileSize = (bytes) => {
      if (!bytes || bytes === 0) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const renderAttachmentPreview = () => {
      const preview = document.getElementById('attachment-preview');
      preview.innerHTML = '';
      if (state.pendingImages.length === 0) {
        preview.style.display = 'none';
        return;
      }
      preview.style.display = 'flex';
      state.pendingImages.forEach((img, idx) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        const getExt = (name) => { if (!name) return ''; const p = name.toLowerCase().split('.'); return p.length > 1 ? p[p.length-1] : ''; };
        const isRealImage = (mimeType, fileName) => { const ext = getExt(fileName); if (ext === 'ts' || ext === 'tsx') return false; return mimeType.startsWith('image/'); };
        const getIcon = (mimeType, fileName) => {
          const ext = getExt(fileName);
          if (mimeType === 'application/pdf') return '📄';
          if (isRealImage(mimeType, fileName)) return '🖼️';
          if (['ts','tsx','js','jsx','mjs','json','jsonc','yaml','yml','toml'].includes(ext)) return '{ }';
          if (ext === 'py') return '🐍';
          if (['md','mdx','txt','rst','docx','doc'].includes(ext)) return '📝';
          if (['html','htm','css','scss'].includes(ext)) return '🌐';
          if (['sql','graphql','gql'].includes(ext)) return '🗃️';
          if (['sh','bash','zsh','ps1','bat'].includes(ext)) return '⚙️';
          if (['csv','tsv','xlsx','xls'].includes(ext)) return '📊';
          if (['zip','tar','gz','rar','7z'].includes(ext)) return '🗜️';
          if (mimeType.startsWith('text/')) return '📝';
          return '📎';
        };
        const isImage = isRealImage(img.mimeType, img.fileName);
        if (isImage) {
          // Show thumbnail for actual images
          const image = document.createElement('img');
          image.src = \`data:\${img.mimeType};base64,\${img.data}\`;
          image.alt = img.fileName || 'image';
          image.onerror = () => {
            image.remove();
            const fallback = document.createElement('div');
            fallback.className = 'file-chip-inner';
            const icon = document.createElement('span');
            icon.className = 'file-chip-icon';
            icon.textContent = '🖼️';
            const label = document.createElement('span');
            label.className = 'file-chip-label';
            label.textContent = img.fileName || 'image';
            label.title = img.fileName || 'image';
            fallback.appendChild(icon);
            fallback.appendChild(label);
            chip.insertBefore(fallback, chip.firstChild);
          };
          chip.appendChild(image);
        } else {
          // File chip for PDFs, text files, code, and other non-image types
          const inner = document.createElement('div');
          inner.className = 'file-chip-inner';
          const icon = document.createElement('span');
          icon.className = 'file-chip-icon';
          icon.textContent = getIcon(img.mimeType, img.fileName);
          const label = document.createElement('span');
          label.className = 'file-chip-label';
          const displayName = img.fileName || img.mimeType;
          label.textContent = displayName;
          label.title = displayName;
          if (img.size) {
            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'file-chip-size';
            sizeSpan.textContent = formatFileSize(img.size);
            inner.appendChild(icon);
            inner.appendChild(label);
            inner.appendChild(sizeSpan);
          } else {
            inner.appendChild(icon);
            inner.appendChild(label);
          }
          chip.appendChild(inner);
        }
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-img';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => {
          state.pendingImages.splice(idx, 1);
          renderAttachmentPreview();
          updateInputArea();
        });
        chip.appendChild(removeBtn);
        preview.appendChild(chip);
      });
    };

    // ── Event Listeners ──
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('btn-new-thread').addEventListener('click', () => {
        post({ type: 'newThread' });
      });

      document.getElementById('btn-toggle-threads').addEventListener('click', () => {
        state.showThreads = !state.showThreads;
        const drawer = document.getElementById('threads-drawer');
        const btn = document.getElementById('btn-toggle-threads');
        if (state.showThreads) {
          state.showSettings = false;
          document.getElementById('settings-drawer').classList.add('hidden');
          document.getElementById('btn-toggle-settings').classList.remove('active');
          drawer.classList.remove('hidden');
          btn.classList.add('active');
          updateThreadsDrawer();
        } else {
          drawer.classList.add('hidden');
          btn.classList.remove('active');
        }
        updateWarning();
      });

      document.getElementById('btn-toggle-settings').addEventListener('click', () => {
        state.showSettings = !state.showSettings;
        const drawer = document.getElementById('settings-drawer');
        const btn = document.getElementById('btn-toggle-settings');
        if (state.showSettings) {
          state.showThreads = false;
          document.getElementById('threads-drawer').classList.add('hidden');
          document.getElementById('btn-toggle-threads').classList.remove('active');
          drawer.classList.remove('hidden');
          btn.classList.add('active');
          updateSettingsDrawer();
        } else {
          drawer.classList.add('hidden');
          btn.classList.remove('active');
        }
        updateWarning();
      });

      document.getElementById('btn-setup-warning').addEventListener('click', () => {
        state.showSettings = true;
        document.getElementById('settings-drawer').classList.remove('hidden');
        document.getElementById('btn-toggle-settings').classList.add('active');
        updateSettingsDrawer();
        updateWarning();
      });

      document.getElementById('btn-mode-ask').addEventListener('click', () => {
        state.mode = 'ask';
        post({ type: 'setMode', mode: 'ask' });
        updateInputArea();
      });

      document.getElementById('btn-mode-agent').addEventListener('click', () => {
        state.mode = 'agent';
        post({ type: 'setMode', mode: 'agent' });
        updateInputArea();
      });

      document.getElementById('btn-send').addEventListener('click', () => {
        if (state.agentPaused) {
          sendMessage();
        } else if (state.streamingId && state.mode === 'agent') {
          // Agent running — abort cleanly (handles both running and paused states)
          post({ type: 'abortAgent' });
          state.agentPaused = false;
          updateInputArea();
        } else if (state.streamingId) {
          // Ask mode streaming
          post({ type: 'stopStream' });
        } else {
          sendMessage();
        }
      });

      document.getElementById('btn-pause').addEventListener('click', () => {
        post({ type: 'pauseAgent' });
        // Optimistically update UI immediately — don't wait for backend ack
        state.agentPaused = true;
        updateInputArea();
      });

      document.getElementById('btn-abort-agent').addEventListener('click', () => {
        // Abort immediately — no LLM round-trip needed
        post({ type: 'abortAgent' });
        state.agentPaused = false;
        updateInputArea();
      });

      // Attachment: file input trigger
      document.getElementById('btn-attach').addEventListener('click', () => {
        document.getElementById('file-input').click();
      });

      document.getElementById('file-input').addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
        for (const file of files) {
          if (file.size > MAX_FILE_SIZE) {
            const preview = document.getElementById('attachment-preview');
            preview.style.display = 'flex';
            const err = document.createElement('span');
            err.style.cssText = 'font-size:11px;color:var(--error,#f44);padding:4px 6px;';
            err.textContent = \`⚠ \${file.name}: too large (max 10 MB)\`;
            preview.appendChild(err);
            setTimeout(() => { err.remove(); if (state.pendingImages.length === 0) preview.style.display = 'none'; }, 4000);
            continue;
          }
          try {
            const b64 = await fileToBase64(file);
            const mime = file.type || 'application/octet-stream';
            state.pendingImages.push({ data: b64, mimeType: mime, fileName: file.name, size: file.size });
          } catch (err) {
            console.error('Failed to read file:', file.name, err);
          }
        }
        e.target.value = '';
        renderAttachmentPreview();
        updateInputArea();
      });

      // Paste image or file from clipboard
      document.getElementById('chat-input').addEventListener('paste', async (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
        for (const item of items) {
          if (item.kind === 'file') {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;
            if (file.size > MAX_FILE_SIZE) {
              const preview = document.getElementById('attachment-preview');
              preview.style.display = 'flex';
              const err = document.createElement('span');
              err.style.cssText = 'font-size:11px;color:var(--error,#f44);padding:4px 6px;';
              err.textContent = \`⚠ Pasted file too large (max 10 MB)\`;
              preview.appendChild(err);
              setTimeout(() => { err.remove(); if (state.pendingImages.length === 0) preview.style.display = 'none'; }, 4000);
              continue;
            }
            try {
              const b64 = await fileToBase64(file);
              state.pendingImages.push({ data: b64, mimeType: item.type || 'application/octet-stream', fileName: file.name || 'pasted-file', size: file.size });
            } catch (err) {
              console.error('Failed to read pasted file:', err);
            }
          }
        }
        if (state.pendingImages.length > 0) {
          renderAttachmentPreview();
          updateInputArea();
        }
      });

      // Drag-and-drop: files dragged onto the chat panel
      const chatContainer = document.getElementById('chat-container') || document.body;
      const dropOverlay = document.getElementById('chat-drop-overlay');

      document.addEventListener('dragenter', (e) => {
        if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          if (dropOverlay) dropOverlay.classList.add('active');
        }
      });
      document.addEventListener('dragover', (e) => {
        if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      document.addEventListener('dragleave', (e) => {
        // Only hide overlay when leaving the window entirely
        if (!e.relatedTarget) {
          if (dropOverlay) dropOverlay.classList.remove('active');
        }
      });
      document.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (dropOverlay) dropOverlay.classList.remove('active');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || files.length === 0) return;
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        for (const file of files) {
          if (file.size > MAX_FILE_SIZE) {
            const preview = document.getElementById('attachment-preview');
            preview.style.display = 'flex';
            const err = document.createElement('span');
            err.style.cssText = 'font-size:11px;color:var(--error,#f44);padding:4px 6px;';
            err.textContent = \`\u26A0 \${file.name}: too large (max 10 MB)\`;
            preview.appendChild(err);
            setTimeout(() => { err.remove(); if (state.pendingImages.length === 0) preview.style.display = 'none'; }, 4000);
            continue;
          }
          try {
            const b64 = await fileToBase64(file);
            const mime = file.type || 'application/octet-stream';
            state.pendingImages.push({ data: b64, mimeType: mime, fileName: file.name, size: file.size });
          } catch (err) {
            console.error('Failed to read dropped file:', file.name, err);
          }
        }
        renderAttachmentPreview();
        updateInputArea();
      });

      const textarea = document.getElementById('chat-input');
      textarea.addEventListener('input', (e) => {
        state.input = e.target.value;
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
        updateInputArea();
      });

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      post({ type: 'ready' });
    });

    // ── Incoming Messages from Extension ──
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'init':
          state.threads = msg.threads;
          state.activeThreadId = msg.activeThreadId;
          state.messages = msg.messages;
          state.mode = msg.mode;
          state.providerStatus = msg.providerStatus;
          state.pinnedFiles = msg.pinnedFiles || [];
          state.snapshot = msg.snapshot;
          state.currentUser = msg.currentUser;
          state.cooldownUser = msg.cooldownUser || null;
          state.cooldownUserName = msg.cooldownUserName || null;
          updateHeader();
          updateWarning();
          updatePinnedFiles();
          updateChatHistory();
          updateInputArea();
          if (state.showSettings) {
            updateSettingsDrawer();
          }
          if (state.showThreads) {
            updateThreadsDrawer();
          }
          post({ type: 'checkVisionSupport' });
          break;

        case 'threadCreated':
          state.contextTokens = 0;
          if (msg.threads) {
            state.threads = msg.threads;
          } else {
            state.threads.push(msg.thread);
          }
          state.activeThreadId = msg.thread.id;
          state.messages = msg.messages;
          updateHeader();
          updateChatHistory();
          if (state.showThreads) {
            updateThreadsDrawer();
          }
          break;

        case 'threadSelected':
          state.contextTokens = 0;
          if (msg.threads) {
            state.threads = msg.threads;
          }
          state.activeThreadId = msg.thread.id;
          state.messages = msg.messages;
          updateHeader();
          updateChatHistory();
          if (state.showThreads) {
            updateThreadsDrawer();
          }
          break;

        case 'contextTokens':
          state.contextTokens = msg.count;
          updateInputArea();
          break;

        case 'messageAdded':
          state.messages.push(msg.message);
          if (msg.message.role === 'assistant' &&
              (msg.message.content === '' || msg.message.content === '🤖 Agent starting…')) {
            state.streamingId = msg.message.id;
          }
          updateChatHistory();
          updateInputArea();
          break;

        case 'messageChunk': {
          state.messages = state.messages.map(m =>
            m.id === msg.messageId ? { ...m, content: m.content + msg.chunk } : m
          );
          const bubbleContainer = document.querySelector(\`[data-msg-id="\${msg.messageId}"]\`);
          if (bubbleContainer) {
            const bubble = bubbleContainer.querySelector('.msg-bubble');
            if (bubble) {
              const thinking = bubble.querySelector('.msg-thinking');
              if (thinking) {
                bubble.innerHTML = '';
              }
              const message = state.messages.find(m => m.id === msg.messageId);
              if (message) {
                renderMarkdownSafe(message.content, bubble);
              }
            }
            const hist = document.getElementById('chat-history');
            if (hist) {
              hist.scrollTop = hist.scrollHeight;
            }
          } else {
            updateChatHistory();
          }
          break;
        }

        case 'messageUpdated':
          state.messages = state.messages.map(m =>
            m.id === msg.message.id ? msg.message : m
          );
          updateChatHistory();
          break;

        case 'messageDone':
          state.streamingId = null;
          state.agentPaused = false;
          state.pausedMessageId = null;
          state.messages = state.messages.map(m =>
            m.id === msg.messageId
              ? { ...m, tokensUsed: msg.totalTokens, model: msg.model }
              : m
          );
          updateChatHistory();
          updateInputArea();
          break;

        case 'aiStatusChanged':
          state.cooldownUser = msg.executingUser || null;
          state.cooldownUserName = msg.executingUserName || null;
          updateInputArea();
          break;

        case 'agentStepUpdate':
          state.messages = state.messages.map(m => {
            if (m.id !== msg.messageId) return m;
            const steps = m.agentSteps || [];
            const idx = steps.findIndex(s => s.id === msg.step.id);
            const newSteps = idx === -1
              ? [...steps, msg.step]
              : steps.map((s, i) => i === idx ? msg.step : s);
            return { ...m, agentSteps: newSteps };
          });
          updateChatHistory();
          break;

        case 'sessionChanged':
          state.snapshot = msg.snapshot;
          updateHeader();
          break;

        case 'providerStatus':
          state.providerStatus = msg.status;
          updateWarning();
          updateInputArea();
          if (state.showSettings) {
            updateSettingsDrawer();
          }
          post({ type: 'checkVisionSupport' });
          break;

        case 'pinnedFilesChanged':
          state.pinnedFiles = msg.pinnedFiles;
          updatePinnedFiles();
          break;

        case 'agentPaused':
          state.agentPaused = true;
          state.pausedMessageId = msg.messageId;
          updateInputArea();
          break;

        case 'agentResumed':
          state.agentPaused = false;
          state.pausedMessageId = null;
          updateInputArea();
          break;

        case 'visionSupport':
          state.visionSupported = msg.supported;
          updateInputArea();
          break;

        case 'error':
          state.messages.push({
            id: Date.now().toString(),
            threadId: state.activeThreadId || 'unknown',
            role: 'assistant',
            content: '❌ ' + msg.message,
            model: undefined,
            tokensUsed: undefined,
            contextRefs: undefined,
            agentSteps: undefined,
            senderId: 'system',
            createdAt: new Date().toISOString()
          });
          updateChatHistory();
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}