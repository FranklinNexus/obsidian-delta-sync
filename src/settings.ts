import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type DeltaSyncPlugin from "./main";
import type { SyncSummary } from "./types";

function summaryText(summary: SyncSummary): string {
  return [
    `Upload: ${summary.uploaded}`,
    `Download: ${summary.downloaded}`,
    `Delete local: ${summary.deletedLocal}`,
    `Delete remote: ${summary.deletedRemote}`,
    `Conflicts: ${summary.conflicts}`,
    `Skipped: ${summary.skipped}`,
    `Local files read: ${summary.localFilesRead}`,
    `Local metadata reused: ${summary.localFilesReused}`,
  ].join("\n");
}

export class SyncSummaryModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly summary: SyncSummary,
    private readonly confirmLabel?: string,
    private readonly onConfirm?: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createDiv({
      cls: "obsidian-delta-sync-summary",
      text: summaryText(this.summary),
    });
    if (this.confirmLabel && this.onConfirm) {
      new Setting(this.contentEl).addButton((button) =>
        button
          .setCta()
          .setButtonText(this.confirmLabel ?? "Confirm")
          .onClick(async () => {
            button.setDisabled(true);
            this.close();
            await this.onConfirm?.();
          }),
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SyncLogModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: DeltaSyncPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Delta Sync history");
    if (this.plugin.data.logs.length === 0) {
      this.contentEl.createEl("p", { text: "No sync attempts yet." });
      return;
    }
    for (const entry of this.plugin.data.logs.slice(0, 20)) {
      const block = this.contentEl.createDiv({ cls: "obsidian-delta-sync-summary" });
      block.createEl("strong", { text: `${entry.status.toUpperCase()} · ${entry.timestamp}` });
      block.createEl("div", { text: entry.message });
      if (entry.summary) block.createEl("pre", { text: summaryText(entry.summary) });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class DeltaSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DeltaSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    const settings = this.plugin.data.settings;

    new Setting(this.containerEl)
      .setName("Repository owner")
      .setDesc("GitHub account or organization that owns the private repository.")
      .addText((text) =>
        text.setValue(settings.owner).onChange(async (value) => {
          settings.owner = value.trim();
          settings.firstSyncConfirmed = false;
          await this.plugin.persistData();
        }),
      );

    new Setting(this.containerEl)
      .setName("Repository")
      .setDesc("Dedicated private repository used for this vault.")
      .addText((text) =>
        text.setValue(settings.repository).onChange(async (value) => {
          settings.repository = value.trim();
          settings.firstSyncConfirmed = false;
          await this.plugin.persistData();
        }),
      );

    new Setting(this.containerEl)
      .setName("Branch")
      .setDesc("The branch root maps directly to the vault root.")
      .addText((text) =>
        text.setValue(settings.branch).onChange(async (value) => {
          settings.branch = value.trim() || "main";
          settings.firstSyncConfirmed = false;
          await this.plugin.persistData();
        }),
      );

    new Setting(this.containerEl)
      .setName("GitHub token")
      .setDesc(
        this.plugin.hasToken()
          ? "A token is stored in Obsidian Secret Storage. Enter a new value to replace it."
          : settings.deviceMode === "writer"
            ? "Use a fine-grained token limited to this repository with Contents read and write access."
            : "Use a fine-grained token limited to this repository with Contents read-only access.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.hasToken() ? "Stored securely" : "github_pat_…");
        text.onChange((value) => {
          text.inputEl.dataset.pendingToken = value;
        });
      })
      .addButton((button) =>
        button.setButtonText("Save token").onClick(() => {
          const input = button.buttonEl.parentElement?.querySelector<HTMLInputElement>("input");
          const token = input?.dataset.pendingToken?.trim() ?? "";
          if (!token) {
            new Notice("Enter a token first.");
            return;
          }
          this.plugin.setToken(token);
          if (input) input.value = "";
          new Notice("Token saved in Obsidian Secret Storage.");
          this.display();
        }),
      );

    new Setting(this.containerEl)
      .setName("Device name")
      .setDesc("Used in commit messages and conflict filenames.")
      .addText((text) =>
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim();
          await this.plugin.persistData();
        }),
      );

    new Setting(this.containerEl)
      .setName("Device role")
      .setDesc(
        "Writer devices can commit local changes. Followers only pull and preserve accidental local edits as conflict copies.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("writer", "Writer")
          .addOption("follower", "Pull-only follower")
          .setValue(settings.deviceMode)
          .onChange(async (value) => {
            settings.deviceMode = value === "follower" ? "follower" : "writer";
            settings.firstSyncConfirmed = false;
            await this.plugin.persistData();
            this.display();
          }),
      );

    new Setting(this.containerEl)
      .setName("Automatic sync")
      .setDesc("Sync after startup, when returning to the app, and on the configured interval.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          settings.autoSync = value;
          await this.plugin.persistData();
          this.plugin.configureAutoSync();
        }),
      );

    new Setting(this.containerEl)
      .setName("Interval in minutes")
      .setDesc("Minimum 1 minute. The default is 5 minutes.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(settings.intervalMinutes)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return;
          settings.intervalMinutes = Math.max(1, Math.round(parsed));
          await this.plugin.persistData();
          this.plugin.configureAutoSync();
        });
      });

    new Setting(this.containerEl)
      .setName("Maximum file size in MB")
      .setDesc("Files above this value are skipped. Default: 25 MB; hard maximum: 100 MB.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(settings.maxFileSizeMb)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return;
          settings.maxFileSizeMb = Math.min(100, Math.max(1, parsed));
          await this.plugin.persistData();
        });
      });

    new Setting(this.containerEl)
      .setName("Additional exclusions")
      .setDesc("One glob per line. .obsidian, .trash and .git are always excluded.")
      .addTextArea((area) =>
        area
          .setValue(settings.excludePatterns.join("\n"))
          .setPlaceholder("Private/**\n**/*.tmp")
          .onChange(async (value) => {
            settings.excludePatterns = value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.persistData();
          }),
      );

    new Setting(this.containerEl)
      .setName("Test connection")
      .setDesc("Checks repository access without changing any files.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.testConnection();
            new Notice("GitHub connection succeeded.");
          } catch (error) {
            new Notice(`Connection failed: ${String(error)}`, 8000);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(this.containerEl)
      .setName("Sync actions")
      .setDesc("Preview before the first sync. No remote force pushes are used.")
      .addButton((button) =>
        button.setButtonText("Preview").onClick(async () => this.plugin.previewSync()),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Sync now")
          .onClick(async () => this.plugin.requestSync()),
      )
      .addButton((button) =>
        button
          .setButtonText("History")
          .onClick(() => new SyncLogModal(this.app, this.plugin).open()),
      );

    new Setting(this.containerEl)
      .setName("Disconnect")
      .setDesc("Clears the stored token and local sync baseline. Remote files are not changed.")
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Disconnect")
          .onClick(async () => {
            await this.plugin.disconnect();
            new Notice("Delta Sync disconnected.");
            this.display();
          }),
      );
  }
}
