import { Notice, Platform, Plugin } from "obsidian";
import { GitHubApiError, GitHubClient } from "./github-client";
import { ObsidianVaultAdapter } from "./obsidian-vault";
import { DeltaSyncSettingTab, SyncSummaryModal } from "./settings";
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
const LOCAL_CHANGE_SYNC_DEBOUNCE_MS = 10_000;
const ANDROID_NOMEDIA_MARKER = ".nomedia";

function getOSName(): string {
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  return "unknown";
}

export default class DeltaSyncPlugin extends Plugin {
  data!: PluginData;
  private statusBar!: HTMLElement;
  private localVault!: ObsidianVaultAdapter;
  private syncPromise: Promise<void> | null = null;
  private intervalId: number | null = null;
  private localChangeSyncTimeout: number | null = null;
  private automaticSyncQueued = false;

  async onload(): Promise<void> {
    await this.loadPluginData();
    await this.ensureAndroidNoMediaMarker();
    this.localVault = new ObsidianVaultAdapter(this.app.vault, this.app);
    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle", "Delta Sync: idle");
    this.addSettingTab(new DeltaSyncSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", (file) => this.handleVaultChange(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.handleVaultChange(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultChange(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleVaultChange(oldPath, file.path)),
    );

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
      if (this.localChangeSyncTimeout !== null) window.clearTimeout(this.localChangeSyncTimeout);
    });
    this.configureAutoSync();
    this.app.workspace.onLayoutReady(() => {
      if (this.data.settings.autoSync) void this.requestSync(false);
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.localChangeSyncTimeout !== null) window.clearTimeout(this.localChangeSyncTimeout);
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
          storedSettings.deviceName || `${Platform.isMobile ? "mobile" : "desktop"}-${getOSName()}`,
        vaultInstanceId,
      },
      syncState: stored?.syncState ?? { ...EMPTY_SYNC_STATE, entries: {} },
      localIndex: stored?.localIndex ?? {},
      logs: stored?.logs ?? [],
    };
    await this.persistData();
  }

  async persistData(): Promise<void> {
    await this.saveData(this.data);
  }

  private async ensureAndroidNoMediaMarker(): Promise<void> {
    if (!Platform.isAndroidApp) return;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(ANDROID_NOMEDIA_MARKER)) return;
    await adapter.write(ANDROID_NOMEDIA_MARKER, "");
  }

  private secretId(): string {
    return `obsidian-delta-sync-${this.data.settings.vaultInstanceId}`.toLowerCase();
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
    return new SyncEngine(this.localVault, this.client(), this.data.settings);
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

  private handleVaultChange(...paths: string[]): void {
    this.localVault.markDirty(...paths);
    this.scheduleLocalChangeSync();
  }

  private scheduleLocalChangeSync(): void {
    if (!this.data.settings.autoSync || this.data.settings.deviceMode !== "writer") return;
    if (this.localChangeSyncTimeout !== null) window.clearTimeout(this.localChangeSyncTimeout);
    this.localChangeSyncTimeout = window.setTimeout(() => {
      this.localChangeSyncTimeout = null;
      void this.requestSync(false);
    }, LOCAL_CHANGE_SYNC_DEBOUNCE_MS);
  }

  private setStatus(phase: SyncPhase, text: string): void {
    this.statusBar.dataset.syncPhase = phase;
    this.statusBar.setText(text);
    this.statusBar.addClass("obsidian-delta-sync-status");
  }

  private appendLog(entry: PluginData["logs"][number]): void {
    this.data.logs.unshift(entry);
    this.data.logs = this.data.logs.slice(0, MAX_LOGS);
  }

  async previewSync(): Promise<void> {
    try {
      this.setStatus("scanning", "Delta Sync: scanning...");
      const preview = await this.engine().preview(this.data.syncState, this.data.localIndex);
      this.data.localIndex = preview.localIndex;
      const summary = summarizePlan(preview.plan);
      this.appendLog({
        timestamp: new Date().toISOString(),
        status: "preview",
        message: "Sync preview completed.",
        summary,
      });
      await this.persistData();
      new SyncSummaryModal(this.app, "Delta Sync preview", summary).open();
      this.setStatus(summary.conflicts > 0 ? "conflict" : "idle", "Delta Sync: preview ready");
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  async requestSync(interactive = true): Promise<void> {
    if (this.syncPromise) {
      if (interactive) new Notice("A Delta Sync operation is already running.");
      else this.automaticSyncQueued = true;
      return this.syncPromise;
    }
    this.syncPromise = this.prepareAndRun(interactive).finally(() => {
      this.syncPromise = null;
      if (this.automaticSyncQueued) {
        this.automaticSyncQueued = false;
        void this.requestSync(false);
      }
    });
    return this.syncPromise;
  }

  private async prepareAndRun(interactive: boolean): Promise<void> {
    try {
      this.setStatus("scanning", "Delta Sync: scanning...");
      const engine = this.engine();
      const preview = await engine.preview(this.data.syncState, this.data.localIndex);
      this.data.localIndex = preview.localIndex;
      await this.persistData();
      const summary = summarizePlan(preview.plan);
      if (!this.data.settings.firstSyncConfirmed) {
        if (!interactive) {
          this.setStatus("idle", "Delta Sync: first sync needs confirmation");
          return;
        }
        new SyncSummaryModal(
          this.app,
          "Confirm first Delta Sync",
          summary,
          "Confirm and sync",
          async () => {
            try {
              this.data.settings.firstSyncConfirmed = true;
              await this.persistData();
              const confirmedEngine = this.engine();
              const confirmedPreview = await confirmedEngine.preview(
                this.data.syncState,
                this.data.localIndex,
              );
              await this.executeSync(confirmedEngine, confirmedPreview);
            } catch (error) {
              await this.handleFailure(error);
            }
          },
        ).open();
        this.setStatus("idle", "Delta Sync: awaiting confirmation");
        return;
      }
      await this.executeSync(engine, preview);
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  private async executeSync(engine: SyncEngine, preview: PreviewResult): Promise<void> {
    let activeEngine = engine;
    let activePreview = preview;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.setStatus("uploading", "Delta Sync: synchronizing...");
        const result = await activeEngine.run(
          this.data.syncState,
          this.data.localIndex,
          activePreview,
        );
        await this.handleSuccess(result);
        return;
      } catch (error) {
        if (attempt >= 2 || !this.isRetryableConflict(error)) throw error;
        this.setStatus("scanning", `Delta Sync: remote changed, retrying ${attempt + 1}/2...`);
        await new Promise((resolve) => window.setTimeout(resolve, 1000 * 2 ** attempt));
        activeEngine = this.engine();
        activePreview = await activeEngine.preview(this.data.syncState, this.data.localIndex);
      }
    }
  }

  private isRetryableConflict(error: unknown): boolean {
    if (!(error instanceof GitHubApiError)) return false;
    if (error.status === 409) return true;
    return error.status === 422 && /fast forward|reference update failed/i.test(error.message);
  }

  private async handleSuccess(result: SyncRunResult): Promise<void> {
    this.data.syncState = result.nextState;
    this.data.localIndex = result.nextLocalIndex;
    this.appendLog({
      timestamp: new Date().toISOString(),
      status: "success",
      message: "Sync completed and verified.",
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      summary: result.summary,
    });
    await this.persistData();
    const phase = result.summary.conflicts > 0 ? "conflict" : "idle";
    this.setStatus(phase, `Delta Sync: ${result.summary.conflicts} conflicts`);
    new Notice(
      `Delta Sync complete: ${result.summary.uploaded} uploaded, ${result.summary.downloaded} downloaded, ${result.summary.conflicts} conflicts.`,
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
    this.setStatus("failed", "Delta Sync: failed");
    new Notice(`Delta Sync failed: ${message}`, 8000);
  }

  async disconnect(): Promise<void> {
    this.app.secretStorage.setSecret(this.secretId(), "");
    this.data.syncState = { ...EMPTY_SYNC_STATE, entries: {} };
    this.data.localIndex = {};
    this.data.settings.firstSyncConfirmed = false;
    this.data.settings.autoSync = false;
    this.configureAutoSync();
    await this.persistData();
  }
}
