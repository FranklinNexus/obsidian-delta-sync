import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PluginData } from "../src/types";

vi.mock("obsidian", () => ({
  Plugin: class {
    readonly mockType = "Plugin";
  },
  PluginSettingTab: class {
    readonly mockType = "PluginSettingTab";
  },
  Modal: class {
    readonly mockType = "Modal";
  },
  Notice: vi.fn(),
  Platform: {},
}));

import DeltaSyncPlugin from "../src/main";

interface Harness {
  data: PluginData;
  handleFailure(error: unknown, interactive: boolean): Promise<void>;
  handleVaultChange(...paths: string[]): void;
  persistData: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  localVault: { markDirty: ReturnType<typeof vi.fn> };
  scheduleLocalChangeSync: ReturnType<typeof vi.fn>;
  syncPromise: Promise<void> | null;
}

function harness(): Harness {
  const plugin = Object.create(DeltaSyncPlugin.prototype) as Harness;
  plugin.data = {
    dataVersion: 1,
    settings: { ...DEFAULT_SETTINGS },
    syncState: { baseCommitSha: null, entries: {} },
    localIndex: {},
    logs: [],
  };
  plugin.persistData = vi.fn().mockResolvedValue(undefined);
  plugin.setStatus = vi.fn();
  plugin.localVault = { markDirty: vi.fn() };
  plugin.scheduleLocalChangeSync = vi.fn();
  plugin.syncPromise = null;
  return plugin;
}

describe("background sync", () => {
  it("persists automatic failures and exposes failed status", async () => {
    const plugin = harness();
    await plugin.handleFailure(new Error("remote write failed"), false);
    expect(plugin.data.logs[0]).toMatchObject({ status: "failed", message: "remote write failed" });
    expect(plugin.persistData).toHaveBeenCalledOnce();
    expect(plugin.setStatus).toHaveBeenCalledWith("failed", "Delta Sync: failed");
  });

  it("marks sync-generated changes dirty without scheduling a self-triggered loop", () => {
    const plugin = harness();
    plugin.syncPromise = Promise.resolve();
    plugin.handleVaultChange("note.md");
    expect(plugin.localVault.markDirty).toHaveBeenCalledWith("note.md");
    expect(plugin.scheduleLocalChangeSync).not.toHaveBeenCalled();
    plugin.syncPromise = null;
    plugin.handleVaultChange("user-edit.md");
    expect(plugin.scheduleLocalChangeSync).toHaveBeenCalledOnce();
  });
});
