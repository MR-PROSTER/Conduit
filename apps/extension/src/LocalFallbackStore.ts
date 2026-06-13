import * as vscode from "vscode";
import type { Draft } from "@codesync/shared-types";

export class LocalFallbackStore {
  private readonly globalState: vscode.Memento;
  private readonly keyPrefix = "codesync:fallback-draft:";
  private readonly indexKey = "codesync:fallback-draft-ids";

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
  }

  async save(draftId: string, draft: Draft): Promise<void> {
    await this.globalState.update(this.getKey(draftId), draft);

    const draftIds = this.getDraftIds();
    if (!draftIds.includes(draftId)) {
      draftIds.push(draftId);
      await this.globalState.update(this.indexKey, draftIds);
    }
  }

  get(draftId: string): Draft | undefined {
    return this.globalState.get<Draft>(this.getKey(draftId));
  }

  list(): Draft[] {
    const draftIds = this.getDraftIds();
    const drafts: Draft[] = [];
    for (const draftId of draftIds) {
      const draft = this.get(draftId);
      if (draft) {
        drafts.push(draft);
      }
    }
    return drafts;
  }

  async remove(draftId: string): Promise<void> {
    await this.globalState.update(this.getKey(draftId), undefined);

    const draftIds = this.getDraftIds();
    const updatedIds = draftIds.filter((id) => id !== draftId);
    await this.globalState.update(this.indexKey, updatedIds);
  }

  async clear(): Promise<void> {
    const draftIds = this.getDraftIds();
    for (const draftId of draftIds) {
      await this.globalState.update(this.getKey(draftId), undefined);
    }
    await this.globalState.update(this.indexKey, undefined);
  }

  private getDraftIds(): string[] {
    return this.globalState.get<string[]>(this.indexKey) || [];
  }

  private getKey(draftId: string): string {
    return `${this.keyPrefix}${draftId}`;
  }
}
