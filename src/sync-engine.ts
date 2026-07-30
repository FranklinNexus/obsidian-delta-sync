import { buildSyncPlan } from "./planner";
import type {
  LocalFileSnapshot,
  LocalIndex,
  LocalVault,
  RemoteFileSnapshot,
  RemoteMutation,
  RemoteRepository,
  RemoteStateEntry,
  RemoteSnapshot,
  SyncPlan,
  SyncRunResult,
  SyncSettings,
  SyncState,
  SyncSummary,
} from "./types";
import { mayNeedReleaseAsset, needsReleaseAsset, shouldExclude } from "./utils";

export interface PreviewResult {
  plan: SyncPlan;
  local: Map<string, LocalFileSnapshot>;
  localIndex: LocalIndex;
  remote: RemoteSnapshot;
}

const DOWNLOAD_CONCURRENCY = 4;

async function forEachWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) return;
      await operation(value);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function emptySummary(plan: SyncPlan): SyncSummary {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skipped: plan.skipped.length,
    localFilesRead: plan.scanStats.read,
    localFilesReused: plan.scanStats.reused,
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

  async preview(state: SyncState, localIndex: LocalIndex = {}): Promise<PreviewResult> {
    const [localResult, unfilteredRemote] = await Promise.all([
      this.localVault.scan(this.maxBytes(), this.settings.excludePatterns, localIndex),
      this.remoteRepository.getSnapshot(state),
    ]);
    const remoteResult = this.filterRemote(unfilteredRemote);
    const skipped = [...localResult.skipped, ...remoteResult.skipped];
    return {
      local: localResult.files,
      localIndex: localResult.index,
      remote: remoteResult.snapshot,
      plan: buildSyncPlan(
        state,
        localResult.files,
        remoteResult.snapshot.commitSha,
        remoteResult.snapshot.files,
        skipped,
        new Date(),
        this.settings.deviceMode,
        localResult.stats,
      ),
    };
  }

  private localFile(local: Map<string, LocalFileSnapshot>, path: string): LocalFileSnapshot {
    const file = local.get(path);
    if (!file) throw new Error(`Local file disappeared during sync: ${path}`);
    return file;
  }

  private async localBytes(
    local: Map<string, LocalFileSnapshot>,
    path: string,
  ): Promise<Uint8Array> {
    const file = this.localFile(local, path);
    return file.bytes ? new Uint8Array(file.bytes) : this.localVault.read(path);
  }

  private remoteFile(remote: RemoteSnapshot, path: string): RemoteFileSnapshot {
    const file = remote.files.get(path);
    if (!file) throw new Error(`Remote file disappeared during sync: ${path}`);
    return file;
  }

  async run(
    state: SyncState,
    localIndex: LocalIndex = {},
    preview?: PreviewResult,
  ): Promise<SyncRunResult> {
    const prepared = preview ?? (await this.preview(state, localIndex));
    const { plan, local, remote } = prepared;
    const summary = emptySummary(plan);
    const mutations: RemoteMutation[] = [];

    const downloads = plan.decisions.filter((decision) => decision.kind === "download-remote");
    await forEachWithConcurrency(downloads, DOWNLOAD_CONCURRENCY, async (decision) => {
      const remoteFile = this.remoteFile(remote, decision.path);
      await this.localVault.write(decision.path, await this.remoteRepository.readBlob(remoteFile));
    });
    summary.downloaded += downloads.length;

    for (const decision of plan.decisions) {
      switch (decision.kind) {
        case "noop": {
          // Existing Git blob-backed binary files are migrated on the first run after upgrade.
          // The branch is not advanced until their Release Assets and manifest are all ready.
          const remoteFile = this.remoteFile(remote, decision.path);
          if (
            this.settings.deviceMode === "writer" &&
            !remoteFile.asset &&
            mayNeedReleaseAsset(decision.path, remoteFile.size)
          ) {
            const localBytes = await this.localBytes(local, decision.path);
            if (needsReleaseAsset(localBytes)) {
              mutations.push({
                path: decision.path,
                kind: "put",
                bytes: localBytes,
                sha: this.localFile(local, decision.path).gitSha,
              });
              summary.uploaded += 1;
            }
          }
          break;
        }
        case "follower-local-only":
          break;
        case "upload-local":
          mutations.push({
            path: decision.path,
            kind: "put",
            bytes: await this.localBytes(local, decision.path),
            sha: this.localFile(local, decision.path).gitSha,
          });
          summary.uploaded += 1;
          break;
        case "download-remote":
          break;
        case "delete-remote":
          mutations.push({ path: decision.path, kind: "delete" });
          summary.deletedRemote += 1;
          break;
        case "delete-local":
          await this.localVault.trash(decision.path);
          summary.deletedLocal += 1;
          break;
        case "follower-restore-remote": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const remoteFile = this.remoteFile(remote, decision.path);
          const [localContent, remoteContent] = await Promise.all([
            this.localBytes(local, decision.path),
            this.remoteRepository.readBlob(remoteFile),
          ]);
          await this.localVault.write(decision.conflictPath, localContent);
          await this.localVault.write(decision.path, remoteContent);
          summary.downloaded += 1;
          summary.conflicts += 1;
          break;
        }
        case "follower-restore-deleted": {
          const remoteFile = this.remoteFile(remote, decision.path);
          await this.localVault.write(
            decision.path,
            await this.remoteRepository.readBlob(remoteFile),
          );
          summary.downloaded += 1;
          summary.conflicts += 1;
          break;
        }
        case "follower-preserve-before-delete":
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          await this.localVault.write(
            decision.conflictPath,
            await this.localBytes(local, decision.path),
          );
          await this.localVault.trash(decision.path);
          summary.deletedLocal += 1;
          summary.conflicts += 1;
          break;
        case "conflict-both-modified": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const remoteFile = this.remoteFile(remote, decision.path);
          await this.localVault.write(
            decision.conflictPath,
            await this.remoteRepository.readBlob(remoteFile),
          );
          mutations.push({
            path: decision.path,
            kind: "put",
            bytes: await this.localBytes(local, decision.path),
            sha: this.localFile(local, decision.path).gitSha,
          });
          mutations.push({
            path: decision.conflictPath,
            kind: "reuse",
            sha: remoteFile.sha,
            size: remoteFile.size,
            ...(remoteFile.asset ? { asset: remoteFile.asset } : {}),
          });
          summary.uploaded += 2;
          summary.downloaded += 1;
          summary.conflicts += 1;
          break;
        }
        case "conflict-local-modified-remote-deleted": {
          if (!decision.conflictPath) throw new Error("Conflict path is missing");
          const localContent = await this.localBytes(local, decision.path);
          await this.localVault.trash(decision.path);
          await this.localVault.write(decision.conflictPath, localContent);
          mutations.push({
            path: decision.conflictPath,
            kind: "put",
            bytes: localContent,
            sha: this.localFile(local, decision.path).gitSha,
          });
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
            await this.remoteRepository.readBlob(remoteFile),
          );
          mutations.push({ path: decision.path, kind: "delete" });
          mutations.push({
            path: decision.conflictPath,
            kind: "reuse",
            sha: remoteFile.sha,
            size: remoteFile.size,
            ...(remoteFile.asset ? { asset: remoteFile.asset } : {}),
          });
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
      if (this.settings.deviceMode === "follower") {
        throw new Error("Follower mode attempted to create a remote mutation");
      }
      const result = await this.remoteRepository.commit(
        remote.commitSha,
        mutations,
        `Sync from ${this.settings.deviceName || "Obsidian"}`,
      );
      finalRemote = this.filterRemote(result.snapshot).snapshot;
      commitSha = result.commitSha;
    }

    const finalLocal = await this.localVault.scan(
      this.maxBytes(),
      this.settings.excludePatterns,
      prepared.localIndex,
    );
    summary.localFilesRead += finalLocal.stats.read;
    const entries: Record<string, RemoteStateEntry> = {};
    for (const [path, remoteFile] of finalRemote.files) {
      const localFile = finalLocal.files.get(path);
      if (localFile?.gitSha !== remoteFile.sha) {
        throw new Error(`Post-sync verification failed for ${path}; sync state was not advanced`);
      }
      entries[path] = {
        blobSha: remoteFile.sha,
        sha256: localFile.sha256,
        size: localFile.size,
        ...(remoteFile.asset ? { asset: remoteFile.asset } : {}),
      };
    }

    return {
      plan,
      summary,
      commitSha,
      nextState: { baseCommitSha: finalRemote.commitSha, entries },
      nextLocalIndex: finalLocal.index,
    };
  }
}

export function summarizePlan(plan: SyncPlan): SyncSummary {
  const summary = emptySummary(plan);
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
        summary.uploaded += 2;
        summary.downloaded += 1;
        summary.conflicts += 1;
        break;
      case "conflict-local-modified-remote-deleted":
        summary.uploaded += 1;
        summary.deletedLocal += 1;
        summary.conflicts += 1;
        break;
      case "conflict-local-deleted-remote-modified":
        summary.downloaded += 1;
        summary.deletedRemote += 1;
        summary.conflicts += 1;
        break;
      case "follower-restore-remote":
        summary.downloaded += 1;
        summary.conflicts += 1;
        break;
      case "follower-restore-deleted":
        summary.downloaded += 1;
        summary.conflicts += 1;
        break;
      case "follower-preserve-before-delete":
        summary.deletedLocal += 1;
        summary.conflicts += 1;
        break;
      case "noop":
      case "follower-local-only":
        break;
    }
  }
  return summary;
}
