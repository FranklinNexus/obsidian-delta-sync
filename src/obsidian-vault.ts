import { TFile, normalizePath, type App, type Vault } from "obsidian";
import type { LocalFileSnapshot, LocalVault } from "./types";
import { gitBlobSha, normalizeVaultPath, sha256, shouldExclude } from "./utils";

export class ObsidianVaultAdapter implements LocalVault {
  constructor(
    private readonly vault: Vault,
    private readonly app: App,
  ) {}

  async scan(
    maxFileSizeBytes: number,
    excludePatterns: string[],
  ): Promise<{ files: Map<string, LocalFileSnapshot>; skipped: string[] }> {
    const files = new Map<string, LocalFileSnapshot>();
    const skipped: string[] = [];
    for (const file of this.vault.getFiles()) {
      const path = normalizeVaultPath(file.path);
      if (shouldExclude(path, excludePatterns)) continue;
      if (file.stat.size > maxFileSizeBytes) {
        skipped.push(`${path} (${file.stat.size} bytes)`);
        continue;
      }
      const bytes = new Uint8Array(await this.vault.readBinary(file));
      files.set(path, {
        path,
        bytes,
        gitSha: await gitBlobSha(bytes),
        sha256: await sha256(bytes),
        size: bytes.length,
      });
    }
    return { files, skipped };
  }

  private async ensureParent(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (this.vault.getFolderByPath(current) === null) await this.vault.createFolder(current);
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
  }

  async trash(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(normalizePath(path));
    if (existing instanceof TFile) await this.app.fileManager.trashFile(existing);
  }
}
