import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class {
    readonly type = "file";
  },
  TFolder: class {
    readonly type = "folder";
  },
  normalizePath: (path: string) => path.replace(/\\/gu, "/").replace(/\/$/u, ""),
}));

import { ObsidianVaultAdapter } from "../src/obsidian-vault";

class MemoryDataAdapter {
  readonly folders = new Set<string>();
  readonly files = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.folders.has(path) || this.files.has(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const immediate = (candidate: string): boolean => {
      if (!candidate.startsWith(prefix)) return false;
      return !candidate.slice(prefix.length).includes("/");
    };
    return {
      files: [...this.files].filter(immediate),
      folders: [...this.folders].filter(immediate),
    };
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    expect(recursive).toBe(false);
    const listing = await this.list(path);
    if (listing.files.length > 0 || listing.folders.length > 0) {
      throw new Error(`Directory is not empty: ${path}`);
    }
    this.folders.delete(path);
  }
}

describe("ObsidianVaultAdapter folder cleanup", () => {
  it("finds unloaded disk folders on the first pass and preserves excluded or non-empty trees", async () => {
    const adapter = new MemoryDataAdapter();
    for (const folder of [
      "old",
      "old/a",
      "old/a/b",
      "keep",
      ".agents",
      ".agents/cache",
      ".obsidian",
      ".obsidian/plugins",
    ]) {
      adapter.folders.add(folder);
    }
    adapter.files.add("keep/note.md");
    const vault = {
      adapter,
      getAllLoadedFiles: () => [],
    };
    const localVault = new ObsidianVaultAdapter(vault as never, {} as never);

    const deleted = await localVault.pruneEmptyFolders([".agents/**", ".obsidian/**"]);

    expect(deleted).toBe(3);
    expect(adapter.folders.has("old")).toBe(false);
    expect(adapter.folders.has("keep")).toBe(true);
    expect(adapter.folders.has(".agents/cache")).toBe(true);
    expect(adapter.folders.has(".obsidian/plugins")).toBe(true);
  });
});
