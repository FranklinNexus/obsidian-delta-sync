import { describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync-engine";
import {
  DEFAULT_SETTINGS,
  EMPTY_SYNC_STATE,
  type DeviceMode,
  type SyncSettings,
} from "../src/types";
import { MemoryRemote, MemoryVault } from "./helpers";

function settings(deviceName: string, deviceMode: DeviceMode = "writer"): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    deviceName,
    deviceMode,
    maxFileSizeMb: 25,
    vaultInstanceId: deviceName,
  };
}

describe("SyncEngine", () => {
  it("uploads from one device and downloads to another", async () => {
    const remote = new MemoryRemote();
    const deviceA = new MemoryVault({ "note.md": "hello" });
    const first = await new SyncEngine(deviceA, remote, settings("device-a")).run({
      ...EMPTY_SYNC_STATE,
      entries: {},
    });
    expect(first.summary.uploaded).toBe(1);

    const deviceB = new MemoryVault();
    const second = await new SyncEngine(deviceB, remote, settings("device-b")).run({
      ...EMPTY_SYNC_STATE,
      entries: {},
    });
    expect(second.summary.downloaded).toBe(1);
    expect(deviceB.text("note.md")).toBe("hello");
  });

  it("keeps both versions when two devices edit the same file", async () => {
    const remote = new MemoryRemote();
    await remote.seed({ "note.md": "base" });
    const deviceA = new MemoryVault({ "note.md": "base" });
    const engineA = new SyncEngine(deviceA, remote, settings("device-a"));
    const baseline = await engineA.run({ ...EMPTY_SYNC_STATE, entries: {} });

    const deviceB = new MemoryVault({ "note.md": "base" });
    const baselineB = await new SyncEngine(deviceB, remote, settings("device-b")).run({
      ...EMPTY_SYNC_STATE,
      entries: {},
    });
    deviceA.setText("note.md", "from A");
    deviceB.setText("note.md", "from B");
    const resultB = await new SyncEngine(deviceB, remote, settings("device-b")).run(
      baselineB.nextState,
      baselineB.nextLocalIndex,
    );
    expect(resultB.summary.uploaded).toBe(1);

    const resultA = await engineA.run(baseline.nextState, baseline.nextLocalIndex);
    expect(resultA.summary.conflicts).toBe(1);
    expect(deviceA.text("note.md")).toBe("from A");
    const conflict = [...deviceA.files.keys()].find((path) => path.includes("sync-conflict"));
    expect(conflict).toBeDefined();
    expect(deviceA.text(conflict ?? "")).toBe("from B");
  });

  it("moves remote deletions to the local trash", async () => {
    const remote = new MemoryRemote();
    await remote.seed({ "delete.md": "remove me" });
    const vault = new MemoryVault({ "delete.md": "remove me" });
    const engine = new SyncEngine(vault, remote, settings("device"));
    const baseline = await engine.run({ ...EMPTY_SYNC_STATE, entries: {} });

    const remoteWriter = new MemoryVault();
    await new SyncEngine(remoteWriter, remote, settings("other")).run(baseline.nextState);
    const result = await engine.run(baseline.nextState, baseline.nextLocalIndex);
    expect(result.summary.deletedLocal).toBe(1);
    expect(vault.trashed).toContain("delete.md");
  });

  it("does not advance state when the remote changes during commit", async () => {
    const remote = new MemoryRemote();
    const vault = new MemoryVault({ "note.md": "content" });
    remote.failNextCommit = true;
    const initial = { ...EMPTY_SYNC_STATE, entries: {} };
    await expect(new SyncEngine(vault, remote, settings("device")).run(initial)).rejects.toThrow(
      "Remote branch changed",
    );
    expect(initial.baseCommitSha).toBeNull();
  });

  it("skips excluded and oversized files", async () => {
    const remote = new MemoryRemote();
    const vault = new MemoryVault({
      ".obsidian/workspace.json": "private",
      "Private/secret.md": "secret",
      "big.bin": "0123456789",
      "ok.md": "ok",
    });
    const custom = {
      ...settings("device"),
      maxFileSizeMb: 0.000005,
      excludePatterns: ["Private/**"],
    };
    const result = await new SyncEngine(vault, remote, custom).run({
      ...EMPTY_SYNC_STATE,
      entries: {},
    });
    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect((await remote.getSnapshot()).files.has("ok.md")).toBe(true);
  });

  it("reads no local content when an indexed vault is unchanged", async () => {
    const remote = new MemoryRemote();
    const vault = new MemoryVault({ "a.md": "a", "b.md": "b" });
    const engine = new SyncEngine(vault, remote, settings("writer"));
    const baseline = await engine.run({ ...EMPTY_SYNC_STATE, entries: {} });
    vault.readCounts.clear();
    const fullSnapshotsBefore = remote.fullSnapshotReads;

    const result = await engine.run(baseline.nextState, baseline.nextLocalIndex);

    expect(result.summary.localFilesRead).toBe(0);
    expect(result.summary.localFilesReused).toBe(2);
    expect(vault.readCounts.size).toBe(0);
    expect(remote.fullSnapshotReads).toBe(fullSnapshotsBefore);
  });

  it("reads and uploads only the changed local file", async () => {
    const remote = new MemoryRemote();
    const vault = new MemoryVault({ "changed.md": "old", "stable.md": "stable" });
    const engine = new SyncEngine(vault, remote, settings("writer"));
    const baseline = await engine.run({ ...EMPTY_SYNC_STATE, entries: {} });
    vault.readCounts.clear();
    vault.setText("changed.md", "new");

    const result = await engine.run(baseline.nextState, baseline.nextLocalIndex);

    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.localFilesRead).toBe(1);
    expect(vault.readCounts.get("changed.md")).toBe(1);
    expect(vault.readCounts.has("stable.md")).toBe(false);
  });

  it("never uploads local-only files from a follower", async () => {
    const remote = new MemoryRemote();
    const follower = new MemoryVault({ "local-only.md": "draft" });
    const result = await new SyncEngine(follower, remote, settings("phone", "follower")).run({
      ...EMPTY_SYNC_STATE,
      entries: {},
    });

    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.skipped).toBe(1);
    expect((await remote.getSnapshot()).files.size).toBe(0);
    expect(follower.text("local-only.md")).toBe("draft");
  });

  it("preserves an accidental follower edit and restores the remote version", async () => {
    const remote = new MemoryRemote();
    await remote.seed({ "note.md": "remote base" });
    const follower = new MemoryVault({ "note.md": "remote base" });
    const engine = new SyncEngine(follower, remote, settings("phone", "follower"));
    const baseline = await engine.run({ ...EMPTY_SYNC_STATE, entries: {} });
    const remoteHead = (await remote.getSnapshot()).commitSha;
    follower.setText("note.md", "accidental local edit");

    const result = await engine.run(baseline.nextState, baseline.nextLocalIndex);

    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.conflicts).toBe(1);
    expect(follower.text("note.md")).toBe("remote base");
    const conflict = [...follower.files.keys()].find((path) =>
      path.includes("sync-conflict-local"),
    );
    expect(conflict).toBeDefined();
    expect(follower.text(conflict ?? "")).toBe("accidental local edit");
    expect((await remote.getSnapshot()).commitSha).toBe(remoteHead);
  });

  it("preserves a follower edit before applying a remote deletion", async () => {
    const remote = new MemoryRemote();
    await remote.seed({ "note.md": "remote base" });
    const follower = new MemoryVault({ "note.md": "remote base" });
    const engine = new SyncEngine(follower, remote, settings("phone", "follower"));
    const baseline = await engine.run({ ...EMPTY_SYNC_STATE, entries: {} });
    follower.setText("note.md", "local edit");
    await remote.remove("note.md");

    const result = await engine.run(baseline.nextState, baseline.nextLocalIndex);

    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.conflicts).toBe(1);
    expect(follower.text("note.md")).toBeUndefined();
    const conflict = [...follower.files.keys()].find((path) =>
      path.includes("sync-conflict-local"),
    );
    expect(follower.text(conflict ?? "")).toBe("local edit");
  });
});
