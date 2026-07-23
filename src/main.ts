import { Notice, Platform, Plugin } from "obsidian";
import { GitHubClient } from "./github-client";
import { ObsidianVaultAdapter } from "./obsidian-vault";
import { DocsSyncSettingTab, SyncSummaryModal } from "./settings";
import { summarizePlan, SyncEngine, type PreviewResult } from "./sync-engine";
import {
  DEFAULT_SETTINGS,
  EMPTY_SYNC_STATE,
  type PluginData,
  type SyncPhase,
  type SyncRunResult,
} from "./types";
import { errorMessage } from "./utils";

const MAX_LOGS = 50;

export default class DocsSyncPlugin extends Plugin {
  data!: PluginData;
  private statusBar!: HTMLElement;
  private syncPromise: Promise<void> | null = null;
  private intervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle", "Docs Sync: idle");
    this.addSettingTab(new DocsSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.requestSync(),
    });
    this.addCommand({
      id: "preview-sync",
      name: "Preview sync",
      callback: () => this.previewSync(),
    });
    this.addCommand({
      id: "test-github-connection",
      name: "Test GitHub connection",
      callback: async () => {
        try {
          await this.testConnection();
          new Notice("GitHub connection succeeded.");
        } catch (error) {
          new Notice(`Connection failed: ${errorMessage(error)}`, 8000);
        }
      },
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.data.settings.autoSync) {
        void this.requestSync(false);
      }
    });
    this.register(() => {
      if (this.intervalId !== null) window.clearInterval(this.intervalId);
    });
    this.configureAutoSync();
    this.app.workspace.onLayoutReady(() => {
      if (this.data.settings.autoSync) void this.requestSync(false);
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PluginData> | null;
    const storedSettings = stored?.settings ?? DEFAULT_SETTINGS;
    const vaultInstanceId =
      storedSettings.vaultInstanceId ||
      crypto
        .randomUUID()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");
    this.data = {
      settings: {
        ...DEFAULT_SETTINGS,
        ...storedSettings,
        deviceName:
          storedSettings.deviceName ||
          `${Platform.isMobile ? "mobile" : "desktop"}-${navigator.platform || "device"}`,
        vaultInstanceId,
      },
      syncState: stored?.syncState ?? { ...EMPTY_SYNC_STATE, entries: {} },
      logs: stored?.logs ?? [],
    };
    await this.persistData();
  }

  async persistData(): Promise<void> {
    await this.saveData(this.data);
  }

  private secretId(): string {
    return `obsidian-docs-sync-${this.data.settings.vaultInstanceId}`.toLowerCase();
  }

  hasToken(): boolean {
    return Boolean(this.app.secretStorage.getSecret(this.secretId()));
  }

  setToken(token: string): void {
    this.app.secretStorage.setSecret(this.secretId(), token.trim());
  }

  private token(): string {
    const token = this.app.secretStorage.getSecret(this.secretId());
    if (!token) throw new Error("GitHub token is not configured");
    return token;
  }

  private client(): GitHubClient {
    const { owner, repository, branch } = this.data.settings;
    if (!owner || !repository || !branch)
      throw new Error("Repository owner, name and branch are required");
    return new GitHubClient({ owner, repository, branch, token: this.token() });
  }

  private engine(): SyncEngine {
    return new SyncEngine(
      new ObsidianVaultAdapter(this.app.vault, this.app),
      this.client(),
      this.data.settings,
    );
  }

  async testConnection(): Promise<void> {
    await this.client().testConnection();
  }

  configureAutoSync(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (!this.data.settings.autoSync) return;
    const milliseconds = Math.max(1, this.data.settings.intervalMinutes) * 60_000;
    this.intervalId = window.setInterval(() => void this.requestSync(false), milliseconds);
  }

  private setStatus(phase: SyncPhase, text: string): void {
    this.statusBar.dataset.syncPhase = phase;
    this.statusBar.setText(text);
    this.statusBar.addClass("obsidian-docs-sync-status");
  }

  private appendLog(entry: PluginData["logs"][number]): void {
    this.data.logs.unshift(entry);
    this.data.logs = this.data.logs.slice(0, MAX_LOGS);
  }

  async previewSync(): Promise<void> {
    try {
      this.setStatus("scanning", "Docs Sync: scanning…");
      const preview = await this.engine().preview(this.data.syncState);
      const summary = summarizePlan(preview.plan);
      this.appendLog({
        timestamp: new Date().toISOString(),
        status: "preview",
        message: "Sync preview completed.",
        summary,
      });
      await this.persistData();
      new SyncSummaryModal(this.app, "Docs Sync preview", summary).open();
      this.setStatus(summary.conflicts > 0 ? "conflict" : "idle", "Docs Sync: preview ready");
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  async requestSync(interactive = true): Promise<void> {
    if (this.syncPromise) {
      if (interactive) new Notice("A Docs Sync operation is already running.");
      return this.syncPromise;
    }
    this.syncPromise = this.prepareAndRun(interactive).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async prepareAndRun(interactive: boolean): Promise<void> {
    try {
      this.setStatus("scanning", "Docs Sync: scanning…");
      const engine = this.engine();
      const preview = await engine.preview(this.data.syncState);
      const summary = summarizePlan(preview.plan);
      if (!this.data.settings.firstSyncConfirmed) {
        if (!interactive) {
          this.setStatus("idle", "Docs Sync: first sync needs confirmation");
          return;
        }
        new SyncSummaryModal(
          this.app,
          "Confirm first sync",
          summary,
          "Confirm and sync",
          async () => {
            try {
              this.data.settings.firstSyncConfirmed = true;
              await this.persistData();
              await this.executeSync(engine, preview);
            } catch (error) {
              await this.handleFailure(error);
            }
          },
        ).open();
        this.setStatus("idle", "Docs Sync: awaiting confirmation");
        return;
      }
      await this.executeSync(engine, preview);
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  private async executeSync(engine: SyncEngine, preview: PreviewResult): Promise<void> {
    this.setStatus("uploading", "Docs Sync: synchronizing…");
    const result = await engine.run(this.data.syncState, preview);
    await this.handleSuccess(result);
  }

  private async handleSuccess(result: SyncRunResult): Promise<void> {
    this.data.syncState = result.nextState;
    this.appendLog({
      timestamp: new Date().toISOString(),
      status: "success",
      message: "Sync completed and verified.",
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      summary: result.summary,
    });
    await this.persistData();
    const phase = result.summary.conflicts > 0 ? "conflict" : "idle";
    this.setStatus(phase, `Docs Sync: ${result.summary.conflicts} conflicts`);
    new Notice(
      `Docs Sync complete: ${result.summary.uploaded} uploaded, ${result.summary.downloaded} downloaded, ${result.summary.conflicts} conflicts.`,
      6000,
    );
  }

  private async handleFailure(error: unknown): Promise<void> {
    const message = errorMessage(error);
    this.appendLog({
      timestamp: new Date().toISOString(),
      status: "failed",
      message,
    });
    await this.persistData();
    this.setStatus("failed", "Docs Sync: failed");
    new Notice(`Docs Sync failed: ${message}`, 8000);
  }

  async disconnect(): Promise<void> {
    this.app.secretStorage.setSecret(this.secretId(), "");
    this.data.syncState = { ...EMPTY_SYNC_STATE, entries: {} };
    this.data.settings.firstSyncConfirmed = false;
    this.data.settings.autoSync = false;
    this.configureAutoSync();
    await this.persistData();
  }
}
