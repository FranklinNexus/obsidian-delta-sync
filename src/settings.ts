import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
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
          .onClick(() => {
            button.setDisabled(true);
            this.close();
            void this.onConfirm?.();
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
      block.createDiv({ text: entry.message });
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

  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.settingSpecs().map(({ name, desc, configure }) => ({
      name,
      desc,
      render: (setting) => configure(setting),
    }));
  }

  // Compatibility fallback for Obsidian versions earlier than 1.13.
  display(): void {
    this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    this.containerEl.empty();
    for (const spec of this.settingSpecs()) {
      const setting = new Setting(this.containerEl).setName(spec.name).setDesc(spec.desc);
      spec.configure(setting);
    }
  }

  private rerender(): void {
    const update = (this as unknown as { update?: () => void }).update;
    if (typeof update === "function") update.call(this);
    else this.renderLegacySettings();
  }

  private persistSettings(afterSave?: () => void): void {
    void this.plugin
      .persistData()
      .then(() => afterSave?.())
      .catch(
        (error: unknown) =>
          new Notice(`Could not save Delta Sync settings: ${String(error)}`, 8000),
      );
  }

  private settingSpecs(): {
    name: string;
    desc: string;
    configure: (setting: Setting) => void;
  }[] {
    const settings = this.plugin.data.settings;

    return [
      {
        name: "Repository owner",
        desc: "GitHub account or organization that owns the private repository.",
        configure: (setting) =>
          setting.addText((text) =>
            text.setValue(settings.owner).onChange((value) => {
              settings.owner = value.trim();
              settings.firstSyncConfirmed = false;
              this.persistSettings();
            }),
          ),
      },
      {
        name: "Repository",
        desc: "Dedicated private repository used for this vault.",
        configure: (setting) =>
          setting.addText((text) =>
            text.setValue(settings.repository).onChange((value) => {
              settings.repository = value.trim();
              settings.firstSyncConfirmed = false;
              this.persistSettings();
            }),
          ),
      },
      {
        name: "Branch",
        desc: "The branch root maps directly to the vault root.",
        configure: (setting) =>
          setting.addText((text) =>
            text.setValue(settings.branch).onChange((value) => {
              settings.branch = value.trim() || "main";
              settings.firstSyncConfirmed = false;
              this.persistSettings();
            }),
          ),
      },
      {
        name: "GitHub token",
        desc: this.plugin.hasToken()
          ? "A token is stored in Obsidian Secret Storage. Enter a new value to replace it."
          : settings.deviceMode === "writer"
            ? "Use a fine-grained token limited to this repository with Contents read and write access."
            : "Use a fine-grained token limited to this repository with Contents read-only access.",
        configure: (setting) => {
          setting
            .addText((text) => {
              text.inputEl.type = "password";
              text.setPlaceholder(this.plugin.hasToken() ? "Stored securely" : "github_pat_…");
              text.onChange((value) => {
                text.inputEl.dataset.pendingToken = value;
              });
            })
            .addButton((button) =>
              button.setButtonText("Save token").onClick(() => {
                const input =
                  button.buttonEl.parentElement?.querySelector<HTMLInputElement>("input");
                const token = input?.dataset.pendingToken?.trim() ?? "";
                if (!token) {
                  new Notice("Enter a token first.");
                  return;
                }
                this.plugin.setToken(token);
                if (input) input.value = "";
                new Notice("Token saved in Obsidian Secret Storage.");
                this.rerender();
              }),
            );
        },
      },
      {
        name: "Device name",
        desc: "Used in commit messages and conflict filenames.",
        configure: (setting) =>
          setting.addText((text) =>
            text.setValue(settings.deviceName).onChange((value) => {
              settings.deviceName = value.trim();
              this.persistSettings();
            }),
          ),
      },
      {
        name: "Device role",
        desc: "Writers can commit local changes. Followers only pull; accidental local edits move to trash before the remote version is restored.",
        configure: (setting) =>
          setting.addDropdown((dropdown) =>
            dropdown
              .addOption("writer", "Writer")
              .addOption("follower", "Pull-only follower")
              .setValue(settings.deviceMode)
              .onChange((value) => {
                settings.deviceMode = value === "follower" ? "follower" : "writer";
                settings.firstSyncConfirmed = false;
                this.persistSettings(() => this.rerender());
              }),
          ),
      },
      {
        name: "Automatic sync",
        desc: "Sync after startup, when returning to the app, and on the configured interval.",
        configure: (setting) =>
          setting.addToggle((toggle) =>
            toggle.setValue(settings.autoSync).onChange((value) => {
              settings.autoSync = value;
              this.plugin.configureAutoSync();
              this.persistSettings();
            }),
          ),
      },
      {
        name: "Interval in minutes",
        desc: "Minimum 1 minute. The default is 5 minutes.",
        configure: (setting) =>
          setting.addText((text) => {
            text.inputEl.type = "number";
            text.setValue(String(settings.intervalMinutes)).onChange((value) => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) return;
              settings.intervalMinutes = Math.max(1, Math.round(parsed));
              this.plugin.configureAutoSync();
              this.persistSettings();
            });
          }),
      },
      {
        name: "Maximum file size in MB",
        desc: "Files above this value are skipped. Default: 25 MB; hard maximum: 100 MB.",
        configure: (setting) =>
          setting.addText((text) => {
            text.inputEl.type = "number";
            text.setValue(String(settings.maxFileSizeMb)).onChange((value) => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) return;
              settings.maxFileSizeMb = Math.min(100, Math.max(1, parsed));
              this.persistSettings();
            });
          }),
      },
      {
        name: "Additional exclusions",
        desc: "One glob per line. Obsidian configuration, .trash and .git are always excluded.",
        configure: (setting) =>
          setting.addTextArea((area) =>
            area
              .setValue(settings.excludePatterns.join("\n"))
              .setPlaceholder("Private/**\n**/*.tmp")
              .onChange((value) => {
                settings.excludePatterns = value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean);
                this.persistSettings();
              }),
          ),
      },
      {
        name: "Test connection",
        desc: "Checks repository access without changing any files.",
        configure: (setting) =>
          setting.addButton((button) =>
            button.setButtonText("Test").onClick(() => {
              button.setDisabled(true);
              void this.plugin
                .testConnection()
                .then(() => new Notice("GitHub connection succeeded."))
                .catch((error: unknown) => new Notice(`Connection failed: ${String(error)}`, 8000))
                .finally(() => button.setDisabled(false));
            }),
          ),
      },
      {
        name: "Sync actions",
        desc: "Preview before the first sync. No remote force pushes are used.",
        configure: (setting) => {
          setting
            .addButton((button) =>
              button.setButtonText("Preview").onClick(() => {
                void this.plugin.previewSync();
              }),
            )
            .addButton((button) =>
              button
                .setCta()
                .setButtonText("Sync now")
                .onClick(() => {
                  void this.plugin.requestSync();
                }),
            )
            .addButton((button) =>
              button
                .setButtonText("History")
                .onClick(() => new SyncLogModal(this.app, this.plugin).open()),
            );
        },
      },
      {
        name: "Disconnect",
        desc: "Clears the stored token and local sync baseline. Remote files are not changed.",
        configure: (setting) =>
          setting.addButton((button) => {
            button.buttonEl.addClass("mod-warning");
            button.setButtonText("Disconnect").onClick(() => {
              void this.plugin
                .disconnect()
                .then(() => {
                  new Notice("Delta Sync disconnected.");
                  this.rerender();
                })
                .catch((error: unknown) => new Notice(`Disconnect failed: ${String(error)}`, 8000));
            });
          }),
      },
    ];
  }
}
