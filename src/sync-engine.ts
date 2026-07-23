import { buildSyncPlan } from "./planner";
import type {
  BaseEntry,
  LocalFileSnapshot,
  LocalVault,
  RemoteFileSnapshot,
  RemoteMutation,
  RemoteRepository,
  RemoteSnapshot,
  SyncPlan,
  SyncRunResult,
  SyncSettings,
  SyncState,
  SyncSummary,
} from "./types";
import { shouldExclude } from "./utils";

export interface PreviewResult {
  plan: SyncPlan;
  local: Map<string, LocalFileSnapshot>;
  remote: RemoteSnapshot;
}

function emptySummary(skipped: number): SyncSummary {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skipped,
  };
}

export class SyncEngine {
  constructor(
    private readonly localVault: LocalVault,
    private readonly remoteRepository: RemoteRepository,
    private readonly settings: SyncSettings,
  ) {}

  private maxBytes(): number {
    return Math.floor(this.settings.maxFileSizeMb * 1024 * 1024);
  }

  private filterRemote(snapshot: RemoteSnapshot): { snapshot: RemoteSnapshot; skipped: string[] } {
    const files = new Map<string, RemoteFileSnapshot>();
    const skipped: string[] = [];
    for (const [path, file] of snapshot.files) {
      if (shouldExclude(path, this.settings.excludePatterns)) continue;
      if (file.size > this.maxBytes()) {
        skipped.push(`${path} (${file.size} bytes remote)`);
        continue;
      }
      files.set(path, file);
    }
    return { snapshot: { ...snapshot, files }, skipped };
  }

  async preview(state: SyncState): Promise<PreviewResult> {
    const [localResult, unfilteredRemote] = await Promise.all([
      this.localVault.scan(this.maxBytes(), this.settings.excludePatterns),
      this.remoteRepository.getSnapshot(),
    ]);
    const remoteResult = this.filterRemote(unfilteredRemote);
    const skipped = [...localResult.skipped, ...remoteResult.skipped];
    return {
      local: localResult.files,
      remote: remoteResult.snapshot,
      plan: buildSyncPlan(
        state,
        localResult.files,
        remoteResult.snapshot.commitSha,
        remoteResult.snapshot.files,
        skipped,
      ),
    };
  }

  private localFile(local: Map<string, LocalFileSnapshot>, path: string): LocalFileSnapshot {
    const file = local.get(path);
    if (!file) throw new Error(`Local file disappeared during sync: ${path}`);
    return file;
  }

  private remoteFile(remote: RemoteSnapshot, path: string): RemoteFileSnapshot {
    const file = remote.files.get(path);
    if (!file) throw new Error(`Remote file disappeared during sync: ${path}`);
    return file;
  }

  async run(state: SyncState, preview?: PreviewResult): Promise<SyncRunResult> {
    const prepared = preview ?? (await this.preview(state));
    const { plan, local, remote } = prepared;
    const summary = emptySummary(plan.skipped.length);
    const mutations: RemoteMutation[] = [];

    for (const decision of plan.decisions) {
      switch (decision.kind) {
        case "noop":
          break;
        case "upload-local": {
          const localFile = this.localFile(local, decision.path);
          mutations.push({ path: decision.path, kind: "put", bytes: localFile.bytes });
          summary.uploaded += 1;
          break;
        }
        case "download-remote": {
          const remoteFile = this.remoteFile(remote, decision.path);
          await this.localVault.write(
            decision.path,
            await this.remoteRepository.readBlob(remoteFile.sha),
          );
          summary.downloaded += 1;
          break;
        }
        case "delete-remote":
          mutations.push({ path: decision.path, kind: "delete" });
          summary.deletedRemote += 1;
          break;
        case "delete-local":
          await this.localVault.trash(decision.path);
          summary.deletedLocal += 1;
          break;
        case "conflict-both-modified": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const localFile = this.localFile(local, decision.path);
          const remoteFile = this.remoteFile(remote, decision.path);
          await this.localVault.write(
            decision.conflictPath,
            await this.remoteRepository.readBlob(remoteFile.sha),
          );
          mutations.push({ path: decision.path, kind: "put", bytes: localFile.bytes });
          mutations.push({ path: decision.conflictPath, kind: "reuse", sha: remoteFile.sha });
          summary.uploaded += 2;
          summary.downloaded += 1;
          summary.conflicts += 1;
          break;
        }
        case "conflict-local-modified-remote-deleted": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const localFile = this.localFile(local, decision.path);
          await this.localVault.trash(decision.path);
          await this.localVault.write(decision.conflictPath, localFile.bytes);
          mutations.push({ path: decision.conflictPath, kind: "put", bytes: localFile.bytes });
          summary.uploaded += 1;
          summary.deletedLocal += 1;
          summary.conflicts += 1;
          break;
        }
        case "conflict-local-deleted-remote-modified": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const remoteFile = this.remoteFile(remote, decision.path);
          await this.localVault.write(
            decision.conflictPath,
            await this.remoteRepository.readBlob(remoteFile.sha),
          );
          mutations.push({ path: decision.path, kind: "delete" });
          mutations.push({ path: decision.conflictPath, kind: "reuse", sha: remoteFile.sha });
          summary.downloaded += 1;
          summary.deletedRemote += 1;
          summary.conflicts += 1;
          break;
        }
      }
    }

    let finalRemote = remote;
    let commitSha = remote.commitSha;
    if (mutations.length > 0) {
      const result = await this.remoteRepository.commit(
        remote.commitSha,
        mutations,
        `Sync from ${this.settings.deviceName || "Obsidian"}`,
      );
      finalRemote = this.filterRemote(result.snapshot).snapshot;
      commitSha = result.commitSha;
    }

    const finalLocal = await this.localVault.scan(this.maxBytes(), this.settings.excludePatterns);
    const entries: Record<string, BaseEntry> = {};
    for (const [path, remoteFile] of finalRemote.files) {
      const localFile = finalLocal.files.get(path);
      if (localFile?.gitSha !== remoteFile.sha) {
        throw new Error(`Post-sync verification failed for ${path}; sync state was not advanced`);
      }
      entries[path] = {
        blobSha: remoteFile.sha,
        sha256: localFile.sha256,
        size: localFile.size,
      };
    }

    return {
      plan,
      summary,
      commitSha,
      nextState: { baseCommitSha: finalRemote.commitSha, entries },
    };
  }
}

export function summarizePlan(plan: SyncPlan): SyncSummary {
  const summary = emptySummary(plan.skipped.length);
  for (const decision of plan.decisions) {
    switch (decision.kind) {
      case "upload-local":
        summary.uploaded += 1;
        break;
      case "download-remote":
        summary.downloaded += 1;
        break;
      case "delete-local":
        summary.deletedLocal += 1;
        break;
      case "delete-remote":
        summary.deletedRemote += 1;
        break;
      case "conflict-both-modified":
      case "conflict-local-deleted-remote-modified":
      case "conflict-local-modified-remote-deleted":
        summary.conflicts += 1;
        break;
      case "noop":
        break;
    }
  }
  return summary;
}
