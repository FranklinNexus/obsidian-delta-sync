import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "../src/planner";
import type { LocalFileSnapshot, RemoteFileSnapshot, SyncState } from "../src/types";

function local(path: string, sha: string): LocalFileSnapshot {
  return { path, bytes: new Uint8Array(), gitSha: sha, sha256: sha, size: 0, mtime: 0 };
}

function remote(path: string, sha: string): RemoteFileSnapshot {
  return { path, sha, size: 0 };
}

function base(path: string, sha: string): SyncState {
  return {
    baseCommitSha: "base",
    entries: { [path]: { blobSha: sha, sha256: sha, size: 0 } },
  };
}

describe("buildSyncPlan", () => {
  it.each([
    ["same content", "b", "b", "b", "noop"],
    ["local edit", "b", "l", "b", "upload-local"],
    ["remote edit", "b", "b", "r", "download-remote"],
    ["local delete", "b", undefined, "b", "delete-remote"],
    ["remote delete", "b", "b", undefined, "delete-local"],
    ["both edit", "b", "l", "r", "conflict-both-modified"],
    ["local edit remote delete", "b", "l", undefined, "conflict-local-modified-remote-deleted"],
    ["local delete remote edit", "b", undefined, "r", "conflict-local-deleted-remote-modified"],
  ])("plans %s", (_name, baseSha, localSha, remoteSha, expected) => {
    const path = "note.md";
    const plan = buildSyncPlan(
      base(path, baseSha),
      new Map(localSha ? [[path, local(path, localSha)]] : []),
      "remote-head",
      new Map(remoteSha ? [[path, remote(path, remoteSha)]] : []),
      [],
      new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]?.kind).toBe(expected);
  });

  it("safely merges a first sync without a common base", () => {
    const plan = buildSyncPlan(
      { baseCommitSha: null, entries: {} },
      new Map([
        ["local.md", local("local.md", "l")],
        ["same.md", local("same.md", "s")],
        ["conflict.md", local("conflict.md", "l2")],
      ]),
      "remote-head",
      new Map([
        ["remote.md", remote("remote.md", "r")],
        ["same.md", remote("same.md", "s")],
        ["conflict.md", remote("conflict.md", "r2")],
      ]),
    );
    expect(Object.fromEntries(plan.decisions.map((item) => [item.path, item.kind]))).toEqual({
      "conflict.md": "conflict-both-modified",
      "local.md": "upload-local",
      "remote.md": "download-remote",
      "same.md": "noop",
    });
  });

  it("drops a stale base entry when the file is absent locally and remotely", () => {
    const plan = buildSyncPlan(base("deleted.pdf", "old"), new Map(), "remote-head", new Map());

    expect(plan.decisions).toEqual([]);
  });

  it.each([
    ["local edit", "b", "l", "b", "follower-replace-remote"],
    ["local delete", "b", undefined, "b", "download-remote"],
    ["both edit", "b", "l", "r", "follower-replace-remote"],
    ["local edit remote delete", "b", "l", undefined, "delete-local"],
    ["local-only first sync", undefined, "l", undefined, "delete-local"],
  ])(
    "plans follower %s without remote mutations",
    (_name, baseSha, localSha, remoteSha, expected) => {
      const path = "note.md";
      const state: SyncState = baseSha ? base(path, baseSha) : { baseCommitSha: null, entries: {} };
      const plan = buildSyncPlan(
        state,
        new Map(localSha ? [[path, local(path, localSha)]] : []),
        remoteSha ? "remote-head" : null,
        new Map(remoteSha ? [[path, remote(path, remoteSha)]] : []),
        [],
        new Date("2026-07-23T00:00:00.000Z"),
        "follower",
      );

      expect(plan.decisions[0]?.kind).toBe(expected);
      expect(plan.decisions.some((decision) => decision.kind === "upload-local")).toBe(false);
      expect(plan.decisions.some((decision) => decision.kind === "delete-remote")).toBe(false);
    },
  );

  it("uses the remote snapshot on a follower's first sync", () => {
    const plan = buildSyncPlan(
      { baseCommitSha: null, entries: {} },
      new Map([
        ["local-only.md", local("local-only.md", "l")],
        ["same.md", local("same.md", "s")],
        ["shared.md", local("shared.md", "l2")],
      ]),
      "remote-head",
      new Map([
        ["remote-only.md", remote("remote-only.md", "r")],
        ["same.md", remote("same.md", "s")],
        ["shared.md", remote("shared.md", "r2")],
      ]),
      [],
      new Date("2026-07-23T00:00:00.000Z"),
      "follower",
    );

    expect(Object.fromEntries(plan.decisions.map((item) => [item.path, item.kind]))).toEqual({
      "local-only.md": "delete-local",
      "remote-only.md": "download-remote",
      "same.md": "noop",
      "shared.md": "follower-replace-remote",
    });
  });
});
