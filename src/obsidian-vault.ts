import { TFile, normalizePath, type App, type Vault } from "obsidian";
import type { LocalFileSnapshot, LocalIndex, LocalScanResult, LocalVault } from "./types";
import { gitBlobSha, normalizeVaultPath, sha256, shouldExclude } from "./utils";

export class ObsidianVaultAdapter implements LocalVault {
  private readonly dirtyPaths = new Set<string>();
  private readonly pendingFolderCreations = new Map<string, Promise<void>>();

  constructor(
    private readonly vault: Vault,
    private readonly app: App,
  ) {}

  markDirty(...paths: string[]): void {
    for (const path of paths) this.dirtyPaths.add(normalizeVaultPath(path));
  }

  async scan(
    maxFileSizeBytes: number,
    excludePatterns: string[],
    localIndex: LocalIndex,
  ): Promise<LocalScanResult> {
    const files = new Map<string, LocalFileSnapshot>();
    const index: LocalIndex = {};
    const skipped: string[] = [];
    const forcedReads = new Set(this.dirtyPaths);
    for (const path of forcedReads) this.dirtyPaths.delete(path);
    let enumerated = 0;
    let read = 0;
    let reused = 0;

    for (const file of this.vault.getFiles()) {
      const path = normalizeVaultPath(file.path);
      if (shouldExclude(path, excludePatterns)) continue;
      enumerated += 1;
      const cached = localIndex[path];
      if (file.stat.size > maxFileSizeBytes) {
        skipped.push(`${path} (${file.stat.size} bytes)`);
        if (
          cached?.size === file.stat.size &&
          cached.mtime === file.stat.mtime &&
          !forcedReads.has(path)
        ) {
          index[path] = cached;
        }
        continue;
      }

      if (
        cached?.size === file.stat.size &&
        cached.mtime === file.stat.mtime &&
        !forcedReads.has(path)
      ) {
        const snapshot: LocalFileSnapshot = {
          path,
          gitSha: cached.blobSha,
          sha256: cached.sha256,
          size: cached.size,
          mtime: cached.mtime,
        };
        files.set(path, snapshot);
        index[path] = cached;
        reused += 1;
        continue;
      }

      const bytes = new Uint8Array(await this.vault.readBinary(file));
      const [gitSha, contentSha256] = await Promise.all([gitBlobSha(bytes), sha256(bytes)]);
      const snapshot: LocalFileSnapshot = {
        path,
        bytes,
        gitSha,
        sha256: contentSha256,
        size: bytes.length,
        mtime: file.stat.mtime,
      };
      files.set(path, snapshot);
      index[path] = {
        blobSha: snapshot.gitSha,
        sha256: snapshot.sha256,
        size: snapshot.size,
        mtime: snapshot.mtime,
      };
      read += 1;
    }
    return { files, index, skipped, stats: { enumerated, read, reused } };
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.adapter.readBinary(normalizePath(path)));
  }

  private async ensureParent(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (this.vault.getFolderByPath(current) !== null) continue;

      const existingCreation = this.pendingFolderCreations.get(current);
      if (existingCreation) {
        await existingCreation;
        continue;
      }

      const creation = this.vault
        .createFolder(current)
        .then(() => undefined)
        .catch((error: unknown) => {
          if (this.vault.getFolderByPath(current) !== null) return;
          throw error;
        });
      this.pendingFolderCreations.set(current, creation);

      try {
        await creation;
      } finally {
        if (this.pendingFolderCreations.get(current) === creation) {
          this.pendingFolderCreations.delete(current);
        }
      }
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    await this.ensureParent(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    const buffer = new Uint8Array(bytes).buffer;
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, buffer);
    } else if (existing === null) {
      await this.vault.createBinary(normalized, buffer);
    } else {
      throw new Error(`Cannot write file because a folder exists at ${normalized}`);
    }
    this.markDirty(normalized);
  }

  async trash(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.fileManager.trashFile(existing);
      this.markDirty(normalized);
    }
  }
}
