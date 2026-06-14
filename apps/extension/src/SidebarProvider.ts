import * as vscode from "vscode";
import type { Draft } from "@conduit/shared-types";
import type { BroadcastHub, CollaborationSnapshot } from "./broadcast.js";
import type { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import type { ConduitWebSocketClient } from "./wsClient.js";
import type { AuthService, ConduitUser, AuthState } from "./AuthService.js";
import { getButtons } from "./state/ButtonConfig.js";
import { getStateManager } from "./state/ExtensionStateManager.js";
import type { ConduitState } from "./state/ExtensionStateManager.js";

export interface SessionDescriptor {
    readonly roomId: string;
    readonly roomName: string;
    readonly ownerEmail: string;
    readonly sessionId: string;
    readonly branch: string;
    readonly status: string;
    readonly participantCount: number;
    readonly hasSavedDraft: boolean;
    readonly draftPath: string | undefined;
}

interface SidebarState {
    authed: boolean;
    user: {
        id: string;
        name: string;
    } | null;
    localUserId: string;
    localUserName: string;
    activeFile: string | null;
    snapshot: CollaborationSnapshot;
    knownSession: SessionDescriptor | null;
    drafts: readonly Draft[];
    conduitState: ConduitState;
    buttons: ReturnType<typeof getButtons>;
    members?: readonly any[];
}

interface SidebarMessage {
    type:
    | "signIn"
    | "signOut"
    | "account"
    | "showAccount"
    | "createRoom"
    | "createSession"
    | "joinRoom"
    | "joinSession"
    | "leaveRoom"
    | "leaveSession"
    | "switchBranch"
    | "refresh"
    | "restoreDraft"
    | "banUser"
    | "ready";
    draftId?: string;
    userId?: string;
    userName?: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "conduit.sidebar";

    private readonly disposables: vscode.Disposable[] = [];
    private view: vscode.WebviewView | undefined;
    private cachedDrafts: readonly Draft[] = [];
    private cachedMembers: Record<string, readonly any[]> = {};
    private lastDraftsFetchTime = 0;
    private draftsPromise: Promise<readonly Draft[]> | null = null;
    private refreshCounter = 0;

    constructor(
        private readonly broadcastHub: BroadcastHub,
        private readonly branchSessionRegistry: BranchSessionRegistry,
        private readonly wsClient: ConduitWebSocketClient,
        private readonly websocketUrl: string,
        private readonly authService: AuthService,
        private readonly localUserId: string,
        private readonly localUserName: string,
        private readonly extensionUri: vscode.Uri
    ) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                void this.refreshView();
            })
        );
    }

    public async refresh(): Promise<void> {
        await this.refreshView();
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

        const initialState = this.buildPlaceholderState();
        webviewView.webview.html = this.renderHtml(webviewView.webview, initialState);

        this.disposables.push(
            this.broadcastHub.onDidBroadcast((event) => {
                if (event.type === "snapshot") {
                    void this.refreshView(event.snapshot);
                }
            }),
            webviewView.webview.onDidReceiveMessage((message: SidebarMessage) => {
                void this.handleMessage(message);
            }),
            webviewView.onDidDispose(() => {
                this.view = undefined;
            })
        );

        void this.refreshView();
    }

    dispose(): void {
        this.view = undefined;
        vscode.Disposable.from(...this.disposables).dispose();
    }

    private async handleMessage(message: SidebarMessage): Promise<void> {
        this.lastDraftsFetchTime = 0; // Clear drafts cache on any user message
        switch (message.type) {
            case "signIn":
                await vscode.commands.executeCommand("conduit.signIn");
                break;
            case "signOut":
                await vscode.commands.executeCommand("conduit.signOut");
                break;
            case "account":
            case "showAccount":
                await vscode.commands.executeCommand("conduit.showAccount");
                break;
            case "createRoom":
                await vscode.commands.executeCommand("conduit.createRoom");
                break;
            case "createSession":
                await vscode.commands.executeCommand("conduit.createSession");
                break;
            case "joinRoom":
                await vscode.commands.executeCommand("conduit.joinRoom");
                break;
            case "joinSession":
                await vscode.commands.executeCommand("conduit.joinSession");
                break;
            case "leaveRoom":
                await vscode.commands.executeCommand("conduit.leaveRoom");
                break;
            case "leaveSession":
                await vscode.commands.executeCommand("conduit.leaveSession");
                break;
            case "switchBranch":
                await vscode.commands.executeCommand("conduit.switchBranch");
                break;
            case "refresh":
                await this.refreshView();
                return;
            case "ready":
                await this.refreshView();
                return;
            case "restoreDraft":
                await vscode.commands.executeCommand("conduit.restoreDrafts");
                break;
            case "banUser":
                if (message.userId) {
                    await this.banUser(message.userId, message.userName);
                }
                break;
        }

        await this.refreshView();
    }

    private buildSidebarState(snapshot = this.broadcastHub.getSnapshot(), authParam: { user: ConduitUser | null | undefined, hasToken: boolean }): SidebarState {
        const activeEditor = vscode.window.activeTextEditor;
        const extensionState = getStateManager().get();
        const conduitState = extensionState.state;
        const effectiveRoom = extensionState.room
            ? {
                ...(snapshot.room ?? {}),
                ...extensionState.room,
                ownerId: snapshot.room?.ownerId ?? this.localUserId
            }
            : snapshot.room;
        const effectiveSession = extensionState.session
            ? {
                ...(snapshot.session ?? {}),
                ...extensionState.session,
                roomId:
                    effectiveRoom?.id ??
                    snapshot.roomId ??
                    snapshot.session?.roomId ??
                    "",
                participants: snapshot.session?.participants ?? [],
                status: snapshot.session?.status ?? "active"
            }
            : snapshot.session;
        const effectiveSnapshot = {
            ...snapshot,
            room: effectiveRoom,
            session: effectiveSession,
            roomId: effectiveRoom?.id ?? snapshot.roomId ?? effectiveSession?.roomId
        };
        const user = authParam.user?.id
            ? {
                id: String(authParam.user.id),
                name: String(authParam.user.username || this.localUserName),
            }
            : null;
        const record = effectiveSnapshot.session?.branch
            ? this.branchSessionRegistry.getRestorableSession(effectiveSnapshot.session.branch) ?? null
            : null;
        const knownSession: SessionDescriptor | null = record ? {
            roomId: record.room.id,
            roomName: record.room.name,
            ownerEmail: (record.room as any).ownerEmail || "unknown",
            sessionId: record.session.id,
            branch: record.session.branch,
            status: record.session.status,
            participantCount: record.participantCount,
            hasSavedDraft: record.hasSavedDraft,
            draftPath: record.draftPath
        } : null;

        return {
            authed: authParam.hasToken && Boolean(authParam.user),
            user,
            localUserId: this.localUserId,
            localUserName: this.localUserName,
            activeFile: activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri, false) : null,
            snapshot: effectiveSnapshot,
            knownSession,
            drafts: [],
            conduitState,
            buttons: getButtons(conduitState),
            members: [],
        };
    }

    private buildPlaceholderState(snapshot = this.broadcastHub.getSnapshot()): SidebarState {
        const extensionState = getStateManager().get();
        const cachedUser = this.authService.getCachedUser();
        const user = extensionState.user ? {
            id: extensionState.user.id,
            email: extensionState.user.email,
            username: extensionState.user.username
        } : cachedUser;
        const authed = extensionState.state !== "SIGNED_OUT" || Boolean(user);
        const state = this.buildSidebarState(snapshot, {
            user,
            hasToken: authed
        });
        state.drafts = this.cachedDrafts;
        state.members = this.cachedMembers[state.snapshot.roomId || ""] || [];
        return state;
    }

    private buildState(snapshot = this.broadcastHub.getSnapshot(), authState: AuthState): SidebarState {
        const state = this.buildSidebarState(snapshot, {
            user: authState.user,
            hasToken: Boolean(authState.accessToken)
        });
        state.members = this.cachedMembers[state.snapshot.roomId || ""] || [];
        return state;
    }

    private async refreshView(snapshot = this.broadcastHub.getSnapshot()): Promise<void> {
        const currentCounter = ++this.refreshCounter;
        const authState = await this.authService.getState();
        if (currentCounter !== this.refreshCounter) {
            return;
        }
        const nextState = this.buildState(snapshot, authState);
        
        // 1. Instantly post update with in-memory cached drafts and members to eliminate network latency
        nextState.drafts = this.cachedDrafts;
        nextState.members = this.cachedMembers[nextState.snapshot.roomId || ""] || [];
        await this.view?.webview.postMessage({
            type: "state",
            state: nextState,
        });

        // 2. Fetch fresh drafts and members asynchronously in the background and update when loaded
        if (nextState.authed) {
            try {
                const roomId = nextState.snapshot.roomId;
                const token = authState.accessToken;
                
                const promises: Promise<any>[] = [this.loadDrafts(nextState.authed)];
                if (roomId && token) {
                    promises.push(this.authService.listMembers(roomId, token).catch(() => []));
                } else {
                    promises.push(Promise.resolve([]));
                }

                const [freshDrafts, freshMembers] = await Promise.all(promises);

                if (roomId) {
                    this.cachedMembers[roomId] = freshMembers;
                }

                if (currentCounter === this.refreshCounter) {
                    nextState.drafts = freshDrafts;
                    nextState.members = freshMembers;
                    await this.view?.webview.postMessage({
                        type: "state",
                        state: nextState,
                    });
                }
            } catch (error) {
                // Ignore background loading errors
            }
        }
    }

    private async loadDrafts(authed: boolean): Promise<readonly Draft[]> {
        if (!authed) {
            this.cachedDrafts = [];
            return [];
        }

        const now = Date.now();
        if (this.draftsPromise) {
            return this.draftsPromise;
        }

        if (now - this.lastDraftsFetchTime < 10000 && this.cachedDrafts.length > 0) {
            return this.cachedDrafts;
        }

        this.draftsPromise = (async () => {
            try {
                const list = await this.wsClient.discoverDrafts();
                const fetched = list.map(item => item.draft).filter(d => d.status === "active");
                this.cachedDrafts = fetched;
                this.lastDraftsFetchTime = Date.now();
                return fetched;
            } catch {
                return this.cachedDrafts;
            } finally {
                this.draftsPromise = null;
            }
        })();

        return this.draftsPromise;
    }

    private renderHtml(webview: vscode.Webview, state: SidebarState): string {
        const nonce = createNonce();
        const initialState = serializeState(state);
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "media", "conduit.svg")
        );
        const fontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "media", "fonts", "Arima-font.ttf")
        );

        const authed = Boolean(state.authed && state.user);
        const snapshot = state.snapshot || {};
        const collaborators = Array.isArray(snapshot.collaborators) ? snapshot.collaborators : [];
        const roomName = snapshot.room?.name || 'No room selected';
        const branchName = snapshot.session?.branch || state.knownSession?.branch || 'No branch';
        const sessionId = snapshot.session?.id || state.knownSession?.sessionId || 'No session';
        const activeFile = state.activeFile || 'No active file';
        const accountName = state.user?.name || state.localUserName || 'Not signed in';
        const roomRepoUrl = snapshot.room?.repoUrl || 'No room';
        const inRoom = state.conduitState === 'IN_ROOM_NO_SESSION' || state.conduitState === 'IN_ROOM_IN_SESSION';

        const escapeHtml = (val: string) => String(val)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const stateLabel = (s: string) => {
            switch (s) {
                case 'connected': return 'Connected';
                case 'connecting': return 'Connecting';
                case 'reconnecting': return 'Reconnecting';
                case 'error': return 'Error';
                default: return 'Disconnected';
            }
        };

        const stateColor = (s: string) => {
            switch (s) {
                case 'connected': return 'var(--good)';
                case 'error': return 'var(--bad)';
                default: return 'var(--warn)';
            }
        };

        const roomTitleHtml = escapeHtml(authed ? roomName : 'Sign in to continue');
        const subtitleHtml = escapeHtml(authed
            ? 'Signed in as ' + accountName
            : 'Sign in to create, join, and restore sessions.');

        const connectionPillHtml = `<span class="dot" style="background:${stateColor(snapshot.state || '')}"></span>${escapeHtml(stateLabel(snapshot.state || ''))}`;

        const detailsHtml = authed
            ? [
                ['Current branch', branchName, 'value'],
                ['Active file', activeFile, 'value code'],
                ['Room ID', snapshot.roomId || 'No room', 'value code'],
                ...(inRoom ? [
                  ['Room name', snapshot.room?.name || 'No room', 'value'],
                  ['Room URL', roomRepoUrl, 'value code'],
                ] : []),
                ['Session', sessionId, 'value code'],
                ['Participants', String(collaborators.length), 'value'],
                ['Account', accountName, 'value'],
              ]
                .map((item) => `<div class="detail"><div class="label">${escapeHtml(item[0])}</div><div class="${item[2]}">${escapeHtml(item[1])}</div></div>`)
                .join('')
            : '<div class="empty" style="grid-column: 1 / -1;">Sign in to create or join a room, manage drafts, and see collaborators.</div>';

        const actionsHtml = state.buttons
            .map((btn) => {
                const cls = [
                    btn.primary ? '' : 'secondary',
                    btn.disabled ? 'disabled' : ''
                ].filter(Boolean).join(' ');
                const disabledAttr = btn.disabled ? 'disabled' : '';
                const style = btn.disabled
                    ? 'opacity:0.4;cursor:not-allowed;pointer-events:none;'
                    : '';
                return `<button data-action="${escapeHtml(btn.id)}" class="${cls}" ${disabledAttr} style="${style}">${escapeHtml(btn.label)}</button>`;
            })
            .join('');

        const collaboratorRole = (col: any, localId: string, ownerId: string | null) => {
            if (col && col.role) return col.role;
            if (col && col.userId && ownerId && col.userId === ownerId) return 'Owner';
            return 'Member';
        };

        const initials = (name: string) => {
            const parts = String(name || 'Anonymous').trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return '?';
            if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
            return (parts[0][0] + parts[1][0]).toUpperCase();
        };

        const roomOwnerId = snapshot.room ? snapshot.room.ownerId : null;
        const isCurrentUserOwner = roomOwnerId && state.localUserId === roomOwnerId;
        const members = state.members || [];
        const mergedCollaborators: any[] = [];
        const activeMap = new Map();
        
        collaborators.forEach((c: any) => {
            activeMap.set(c.userId, c);
        });

        if (members.length > 0) {
            members.forEach((member: any) => {
                const activePres = activeMap.get(member.userId);
                if (activePres) {
                    mergedCollaborators.push({
                        userId: member.userId,
                        name: member.name || activePres.name || 'Anonymous',
                        color: activePres.color || '#666',
                        active: true,
                        role: member.role || activePres.role || 'Member',
                        status: activePres.status || 'online'
                    });
                } else {
                    mergedCollaborators.push({
                        userId: member.userId,
                        name: member.name || 'Anonymous',
                        color: '#666',
                        active: false,
                        role: member.role || 'Member',
                        status: 'offline'
                    });
                }
            });
        } else {
            // Fallback: just show active ones
            collaborators.forEach((c: any) => {
                mergedCollaborators.push({
                    userId: c.userId,
                    name: c.name || 'Anonymous',
                    color: c.color || '#666',
                    active: true,
                    role: c.role || (c.userId === roomOwnerId ? 'Owner' : 'Member'),
                    status: c.status || 'online'
                });
            });
        }

        // Sort active on top
        mergedCollaborators.sort((a, b) => {
            if (a.active && !b.active) return -1;
            if (!a.active && b.active) return 1;
            return 0;
        });

        const collaboratorsHtml = authed
            ? (mergedCollaborators.length
                ? mergedCollaborators
                    .map((col) => {
                        const name = col.name || col.userId || 'Anonymous';
                        const role = col.role;
                        const isGithubUser = name && name !== 'Conduit User' && name !== 'Anonymous' && !name.includes(' ') && !name.includes('@');
                        
                        const avatarHtml = isGithubUser
                            ? `<div class="avatar" style="background:${escapeHtml(col.color || '#666')};position:relative;display:grid;">
                                   ${escapeHtml(initials(name))}
                                   <img src="https://github.com/${escapeHtml(name)}.png" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:999px;object-fit:cover;display:block;" onerror="this.remove();" />
                               </div>`
                            : `<div class="avatar" style="background:${escapeHtml(col.color || '#666')};display:grid;">${escapeHtml(initials(name))}</div>`;

                        const isOwner = role.toLowerCase() === 'owner' || col.userId === roomOwnerId;
                        const roleBadgeHtml = isOwner
                            ? `<span class="owner-crown" title="Room Owner" style="font-size: 16px; margin-right: 4px; display: inline-block; filter: drop-shadow(0 0 2px rgba(255, 215, 0, 0.5));">👑</span>`
                            : `<span class="badge ${role.toLowerCase()}">${escapeHtml(role)}</span>`;

                        const banButtonHtml = isCurrentUserOwner && col.userId !== roomOwnerId
                            ? `<button class="ban-btn" data-action="banUser" data-user-id="${col.userId}" data-user-name="${escapeHtml(name)}" title="Ban user from room" style="padding: 2px 6px; font-size: 10px; border-radius: 6px; background: rgba(255, 75, 75, 0.15); border: 1px solid rgba(255, 75, 75, 0.3); color: #ff8888;">Ban</button>`
                            : ``;

                        const rightSideHtml = `<div style="display: flex; align-items: center; gap: 6px;">
                            ${roleBadgeHtml}
                            ${banButtonHtml}
                        </div>`;

                        return `
                        <div class="collaborator ${col.active ? '' : 'inactive'}">
                            <div class="collaborator-main">
                                <div class="avatar-wrapper">
                                    ${avatarHtml}
                                    <span class="presence ${col.active ? '' : 'offline'}"></span>
                                </div>
                                <div class="name-stack">
                                    <div class="name">${escapeHtml(name)}</div>
                                    <div class="status">${escapeHtml(col.status || 'online')}</div>
                                </div>
                            </div>
                            ${rightSideHtml}
                        </div>`;
                    })
                    .join('')
                : '<div class="empty">No collaborators yet.</div>')
            : '<div class="empty">Sign in to view collaborators.</div>';

        const drafts = state.drafts || [];
        const draftsHtml = drafts.length
            ? drafts
                .map((draft) => {
                    return `
                    <div class="collaborator">
                        <div class="collaborator-main">
                            <div class="avatar" style="background: linear-gradient(135deg, var(--accent), #5e2f1d);">DS</div>
                            <div class="name-stack">
                                <div class="name">${escapeHtml(draft.branch || 'Draft')}</div>
                                <div class="status">${escapeHtml(draft.id)} · ${escapeHtml(draft.status)}</div>
                            </div>
                        </div>
                        <button class="secondary" data-action="restoreDraft" data-draft-id="${escapeHtml(draft.id)}">Restore</button>
                    </div>`;
                })
                .join('')
            : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https://github.com https://avatars.githubusercontent.com; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    @font-face {
      font-family: 'Arima';
      src: url('${fontUri}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }

    :root {
      --bg: color-mix(in srgb, var(--vscode-sideBar-background) 84%, #0b0f14 16%);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, #101418 18%);
      --panel-2: color-mix(in srgb, var(--vscode-editorWidget-background) 68%, #0f1319 32%);
      --border: color-mix(in srgb, var(--vscode-editorWidget-border) 82%, transparent);
      --soft: var(--vscode-descriptionForeground);
      --accent: color-mix(in srgb, var(--vscode-button-background) 74%, #efbf8d 26%);
      --accent-hover: color-mix(in srgb, var(--vscode-button-hoverBackground) 72%, #f1c999 28%);
      --good: #50d37c;
      --warn: #ffbf4d;
      --bad: #ff6b6b;
      --shadow: 0 14px 28px rgba(0, 0, 0, 0.22);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--vscode-foreground);
      font-family: 'Arima', var(--vscode-font-family), sans-serif;
      min-height: 100vh;
    }

    .shell {
      padding: 10px;
      display: grid;
      gap: 10px;
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .hero {
      padding: 12px;
      display: grid;
      gap: 12px;
    }

    .hero-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }

    .eyebrow {
      margin: 0 0 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--soft);
    }

    .hero h1 {
      margin: 0;
      font-size: 19px;
      line-height: 1.15;
      letter-spacing: 0.01em;
    }

    .subtle {
      color: var(--soft);
      font-size: 12px;
      line-height: 1.45;
      margin-top: 5px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.16);
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

    .details {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 16px;
    }

    .detail {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--soft);
    }

    .value {
      font-size: 13px;
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .value.code {
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
      font-size: 12px;
      font-weight: 500;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--accent);
      color: var(--vscode-button-foreground);
      font: inherit;
      font-size: 12px;
      padding: 7px 12px;
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
    }

    button:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }

    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
    }

    button.primary {
      background: var(--accent);
    }

    button.disabled {
      opacity: 0.55;
      pointer-events: none;
    }

    .section {
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--soft);
    }

    .count {
      font-size: 11px;
      color: var(--soft);
    }

    .collaborators {
      display: grid;
      gap: 8px;
    }

    .collaborator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.025);
    }

    .collaborator-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .avatar-wrapper {
      position: relative;
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
    }

    .avatar {
      position: relative;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      color: white;
      flex: 0 0 auto;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
      overflow: hidden;
    }

    .presence {
      position: absolute;
      right: -1px;
      bottom: -1px;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--good);
      border: 2px solid color-mix(in srgb, var(--panel) 80%, #000 20%);
    }

    .presence.offline {
      background: #7a7a7a;
    }

    .collaborator.inactive {
      opacity: 0.5;
    }

    .ban-btn:hover {
      background: rgba(255, 75, 75, 0.3) !important;
      color: #ff9999 !important;
      transform: none !important;
    }

    .name-stack {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .name {
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status {
      font-size: 12px;
      color: var(--soft);
    }

    .badge {
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .badge.owner {
      background: rgba(239, 191, 141, 0.18);
      color: #ffd6a7;
      border-color: rgba(239, 191, 141, 0.28);
    }

    .badge.admin {
      background: rgba(113, 186, 255, 0.16);
      color: #b8dbff;
      border-color: rgba(113, 186, 255, 0.28);
    }

    .badge.member {
      background: rgba(255, 255, 255, 0.07);
      color: var(--soft);
      border-color: var(--border);
    }

    .empty {
      padding: 12px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--soft);
      font-size: 12px;
      background: rgba(255, 255, 255, 0.015);
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow" style="display: flex; align-items: center; gap: 6px;">
            <img src="${logoUri}" alt="Conduit Logo" style="width: 14px; height: 14px;">
            Conduit
          </div>
          <h1 id="roomTitle">${roomTitleHtml}</h1>
          <div class="subtle" id="subtitle">${subtitleHtml}</div>
        </div>
        <div class="pill" id="connectionPill">${connectionPillHtml}</div>
      </div>

      <div class="details" id="details">${detailsHtml}</div>

      <div class="actions" id="actions">${actionsHtml}</div>
    </section>

    <section class="panel section">
      <div class="section-head">
        <div class="section-title">Active collaborators</div>
        <div class="count" id="participantCount">${collaborators.length} collaborator${collaborators.length === 1 ? '' : 's'}</div>
      </div>
      <div id="collaborators" class="collaborators">${collaboratorsHtml}</div>
    </section>

    <section class="panel section" id="draftsSection" ${drafts.length ? '' : 'hidden'}>
      <div class="section-head">
        <div class="section-title">Drafts</div>
        <div class="count" id="draftCount">${drafts.length}</div>
      </div>
      <div id="drafts" class="collaborators">${draftsHtml}</div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialState = ${initialState};
    const roomTitle = document.getElementById('roomTitle');
    const subtitle = document.getElementById('subtitle');
    const connectionPill = document.getElementById('connectionPill');
    const detailsEl = document.getElementById('details');
    const actionsEl = document.getElementById('actions');
    const collaboratorsEl = document.getElementById('collaborators');
    const participantCountEl = document.getElementById('participantCount');
    const draftsSectionEl = document.getElementById('draftsSection');
    const draftsEl = document.getElementById('drafts');
    const draftCountEl = document.getElementById('draftCount');
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
        case 'connected':
          return 'Connected';
        case 'connecting':
          return 'Connecting';
        case 'reconnecting':
          return 'Reconnecting';
        case 'error':
          return 'Error';
        default:
          return 'Disconnected';
      }
    }

    function stateColor(state) {
      switch (state) {
        case 'connected':
          return 'var(--good)';
        case 'error':
          return 'var(--bad)';
        default:
          return 'var(--warn)';
      }
    }

    function initials(name) {
      const parts = String(name || 'Anonymous').trim().split(/\\s+/).filter(Boolean);
      if (parts.length === 0) {
        return '?';
      }
      if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
      }
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function collaboratorRole(collaborator, localUserId, roomOwnerId) {
      if (collaborator && collaborator.role) {
        return collaborator.role;
      }
      if (collaborator && collaborator.userId && roomOwnerId && collaborator.userId === roomOwnerId) {
        return 'Owner';
      }
      return 'Member';
    }

    function deriveConduitState(state) {
      if (!(state.authed && state.user)) {
        return 'SIGNED_OUT';
      }

      const snapshot = state.snapshot || {};
      const hasRoom = Boolean(snapshot.room);
      const hasSession = Boolean(snapshot.session);

      if (!hasRoom) {
        return 'SIGNED_IN_NO_ROOM';
      }

      if (!hasSession) {
        return 'IN_ROOM_NO_SESSION';
      }

      return 'IN_ROOM_IN_SESSION';
    }

    function render(state) {
      const authed = Boolean(state.authed && state.user);
      const snapshot = state.snapshot || {};
      const collaborators = Array.isArray(snapshot.collaborators) ? snapshot.collaborators : [];
      const drafts = Array.isArray(state.drafts) ? state.drafts : [];
      const roomName = snapshot.room?.name || 'No room selected';
      const branchName = snapshot.session?.branch || state.knownSession?.branch || 'No branch';
      const sessionId = snapshot.session?.id || state.knownSession?.sessionId || 'No session';
      const websocketUrl = snapshot.websocketUrl || ${JSON.stringify(this.websocketUrl)};
      const activeFile = state.activeFile || 'No active file';
      const accountName = state.user?.name || state.localUserName || 'Not signed in';
      const roomRepoUrl = snapshot.room?.repoUrl || 'No room';
      const inRoom = state.conduitState === 'IN_ROOM_NO_SESSION' || state.conduitState === 'IN_ROOM_IN_SESSION';

      roomTitle.textContent = authed ? roomName : 'Sign in to continue';
      subtitle.textContent = authed
        ? 'Signed in as ' + accountName
        : 'Sign in to create, join, and restore sessions.';

      connectionPill.innerHTML = '<span class="dot" style="background:' + stateColor(snapshot.state) + '"></span>' + escapeHtml(stateLabel(snapshot.state));

      detailsEl.innerHTML = authed
        ? [
            ['Current branch', branchName, 'value'],
            ['Active file', activeFile, 'value code'],
            ['Room ID', snapshot.roomId || 'No room', 'value code'],
            ...(inRoom ? [
              ['Room name', snapshot.room?.name || 'No room', 'value'],
              ['Room URL', roomRepoUrl, 'value code'],
            ] : []),
            ['Session', sessionId, 'value code'],
            ['Participants', String(collaborators.length), 'value'],
            ['Account', accountName, 'value'],
          ]
            .map((item) => '<div class="detail"><div class="label">' + escapeHtml(item[0]) + '</div><div class="' + item[2] + '">' + escapeHtml(item[1]) + '</div></div>')
            .join('')
        : '<div class="empty" style="grid-column: 1 / -1;">Sign in to create or join a room, manage drafts, and see collaborators.</div>';

      actionsEl.innerHTML = state.buttons
        .map((btn) => {
          const cls = [
            btn.primary ? '' : 'secondary',
            btn.disabled ? 'disabled' : ''
          ].filter(Boolean).join(' ');
          const disabledAttr = btn.disabled ? 'disabled' : '';
          const style = btn.disabled
            ? 'opacity:0.4;cursor:not-allowed;pointer-events:none;'
            : '';
          return '<button ' +
            'data-action="' + escapeHtml(btn.id) + '" ' +
            'class="' + cls + '" ' +
            disabledAttr + ' ' +
            'style="' + style + '">' +
            escapeHtml(btn.label) +
            '</button>';
        })
        .join('');

      const members = Array.isArray(state.members) ? state.members : [];
      const mergedCollaborators = [];
      const activeMap = new Map();
      collaborators.forEach((c) => {
        activeMap.set(c.userId, c);
      });

      const roomOwnerId = state.snapshot && state.snapshot.room ? state.snapshot.room.ownerId : null;
      const isCurrentUserOwner = roomOwnerId && state.localUserId === roomOwnerId;

      if (members.length > 0) {
        members.forEach((member) => {
          const activePres = activeMap.get(member.userId);
          if (activePres) {
            mergedCollaborators.push({
              userId: member.userId,
              name: member.name || activePres.name || 'Anonymous',
              color: activePres.color || '#666',
              active: true,
              role: member.role || activePres.role || 'Member',
              status: activePres.status || 'online'
            });
          } else {
            mergedCollaborators.push({
              userId: member.userId,
              name: member.name || 'Anonymous',
              color: '#666',
              active: false,
              role: member.role || 'Member',
              status: 'offline'
            });
          }
        });
      } else {
        // Fallback: just show active ones
        collaborators.forEach((c) => {
          mergedCollaborators.push({
            userId: c.userId,
            name: c.name || 'Anonymous',
            color: c.color || '#666',
            active: true,
            role: c.role || (c.userId === roomOwnerId ? 'Owner' : 'Member'),
            status: c.status || 'online'
          });
        });
      }

      // Sort active on top
      mergedCollaborators.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return 0;
      });

      participantCountEl.textContent = mergedCollaborators.length + ' collaborator' + (mergedCollaborators.length === 1 ? '' : 's');

      collaboratorsEl.innerHTML = authed
        ? (mergedCollaborators.length
            ? mergedCollaborators
                .map((collaborator, index) => {
                  const name = collaborator.name || collaborator.userId || 'Anonymous';
                  const role = collaborator.role;
                  const isGithubUser = name && name !== 'Conduit User' && name !== 'Anonymous' && !name.includes(' ') && !name.includes('@');
                  
                  let avatarHtml = '';
                  if (isGithubUser) {
                    avatarHtml = '<div class="avatar" style="background:' + escapeHtml(collaborator.color || '#666') + '; position: relative; display: grid;">' +
                                 escapeHtml(initials(name)) +
                                 '<img src="https://github.com/' + escapeHtml(name) + '.png" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 999px; object-fit: cover; display: block;" onerror="this.remove();" />' +
                                 '</div>';
                  } else {
                    avatarHtml = '<div class="avatar" style="background:' + escapeHtml(collaborator.color || '#666') + '; display: grid;">' + escapeHtml(initials(name)) + '</div>';
                  }

                  const isOwner = role.toLowerCase() === 'owner' || collaborator.userId === roomOwnerId;
                  const roleBadgeHtml = isOwner
                      ? '<span class="owner-crown" title="Room Owner" style="font-size: 16px; margin-right: 4px; display: inline-block; filter: drop-shadow(0 0 2px rgba(255, 215, 0, 0.5));">👑</span>'
                      : '<span class="badge ' + role.toLowerCase() + '">' + escapeHtml(role) + '</span>';

                  const banButtonHtml = isCurrentUserOwner && collaborator.userId !== roomOwnerId
                      ? '<button class="ban-btn" data-action="banUser" data-user-id="' + collaborator.userId + '" data-user-name="' + escapeHtml(name) + '" title="Ban user from room" style="padding: 2px 6px; font-size: 10px; border-radius: 6px; background: rgba(255, 75, 75, 0.15); border: 1px solid rgba(255, 75, 75, 0.3); color: #ff8888;">Ban</button>'
                      : '';

                  const rightSideHtml = '<div style="display: flex; align-items: center; gap: 6px;">' +
                      roleBadgeHtml +
                      banButtonHtml +
                      '</div>';

                  return [
                    '<div class="collaborator ' + (collaborator.active ? '' : 'inactive') + '">',
                      '<div class="collaborator-main">',
                        '<div class="avatar-wrapper">',
                          avatarHtml,
                          '<span class="presence ' + (collaborator.active ? '' : 'offline') + '"></span>',
                        '</div>',
                        '<div class="name-stack">',
                          '<div class="name">' + escapeHtml(name) + '</div>',
                          '<div class="status">' + escapeHtml(collaborator.status || 'online') + '</div>',
                        '</div>',
                      '</div>',
                      rightSideHtml,
                    '</div>',
                  ].join('');
                })
                .join('')
            : '<div class="empty">No collaborators yet.</div>')
        : '<div class="empty">Sign in to view collaborators.</div>';

      draftsSectionEl.hidden = !drafts.length;
      draftCountEl.textContent = String(drafts.length);
      draftsEl.innerHTML = drafts.length
        ? drafts
            .map((draft) => {
              return [
                '<div class="collaborator">',
                  '<div class="collaborator-main">',
                    '<div class="avatar" style="background: linear-gradient(135deg, var(--accent), #5e2f1d);">',
                      'DS',
                    '</div>',
                    '<div class="name-stack">',
                      '<div class="name">' + escapeHtml(draft.branch || 'Draft') + '</div>',
                      '<div class="status">' + escapeHtml(draft.id) + ' · ' + escapeHtml(draft.status) + '</div>',
                    '</div>',
                  '</div>',
                  '<button class="secondary" data-action="restoreDraft" data-draft-id="' + escapeHtml(draft.id) + '">Restore</button>',
                '</div>',
              ].join('');
            })
            .join('')
        : '';
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) {
        return;
      }

      if (button.classList.contains('disabled')) {
        return;
      }

      vscode.postMessage({
        type: button.dataset.action,
        draftId: button.dataset.draftId,
        userId: button.dataset.userId,
        userName: button.dataset.userName,
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
    vscode.postMessage({
      type: 'ready'
    });
  </script>
</body>
</html>`;
    }

    private async banUser(userId: string, userName?: string): Promise<void> {
        const state = await this.authService.requireState();
        const snapshot = this.broadcastHub.getSnapshot();
        const roomId = snapshot.room?.id ?? snapshot.roomId;
        if (!roomId) {
            void vscode.window.showErrorMessage("No room selected");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to ban ${userName || 'this user'}?`,
            { modal: true },
            "Yes, Ban"
        );

        if (confirm !== "Yes, Ban") {
            return;
        }

        try {
            await this.authService.banMember(roomId, userId, "Banned by room owner", state.accessToken);
            void vscode.window.showInformationMessage(`Successfully banned ${userName || 'user'}.`);
            void this.refreshView();
        } catch (error: any) {
            void vscode.window.showErrorMessage(`Failed to ban user: ${error.message || String(error)}`);
        }
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
