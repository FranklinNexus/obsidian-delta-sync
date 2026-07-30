import type {
  DeviceMode,
  LocalFileSnapshot,
  LocalScanStats,
  RemoteFileSnapshot,
  SyncDecision,
  SyncPlan,
  SyncState,
} from "./types";
import { conflictPath } from "./utils";

function allPaths(
  base: SyncState,
  local: Map<string, LocalFileSnapshot>,
  remote: Map<string, RemoteFileSnapshot>,
): string[] {
  return [...new Set([...Object.keys(base.entries), ...local.keys(), ...remote.keys()])].sort();
}

export function buildSyncPlan(
  base: SyncState,
  local: Map<string, LocalFileSnapshot>,
  remoteCommitSha: string | null,
  remote: Map<string, RemoteFileSnapshot>,
  skipped: string[] = [],
  now = new Date(),
  deviceMode: DeviceMode = "writer",
  scanStats: LocalScanStats = { enumerated: local.size, read: local.size, reused: 0 },
): SyncPlan {
  const decisions: SyncDecision[] = [];
  const planSkipped = [...skipped];
  const remoteSource = remoteCommitSha ? `github-${remoteCommitSha.slice(0, 7)}` : "remote";

  for (const path of allPaths(base, local, remote)) {
    const baseSha = base.entries[path]?.blobSha;
    const localFile = local.get(path);
    const remoteFile = remote.get(path);
    const localSha = localFile?.gitSha;
    const remoteSha = remoteFile?.sha;

    if (localSha === remoteSha) {
      decisions.push({ path, kind: "noop" });
      continue;
    }

    const localChanged = localSha !== baseSha;
    const remoteChanged = remoteSha !== baseSha;

    if (localChanged && !remoteChanged) {
      if (deviceMode === "follower") {
        if (localFile && remoteFile) {
          decisions.push({
            path,
            kind: "follower-restore-remote",
            conflictPath: conflictPath(path, "local", now),
          });
        } else if (!localFile && remoteFile) {
          decisions.push({ path, kind: "follower-restore-deleted" });
        } else {
          decisions.push({ path, kind: "follower-local-only" });
          planSkipped.push(`${path} (local-only file on follower)`);
        }
        continue;
      }
      decisions.push({ path, kind: localFile ? "upload-local" : "delete-remote" });
      continue;
    }

    if (!localChanged && remoteChanged) {
      decisions.push({ path, kind: remoteFile ? "download-remote" : "delete-local" });
      continue;
    }

    if (localFile && remoteFile) {
      if (deviceMode === "follower") {
        decisions.push({
          path,
          kind: "follower-restore-remote",
          conflictPath: conflictPath(path, "local", now),
        });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-both-modified",
        conflictPath: conflictPath(path, remoteSource, now),
      });
    } else if (localFile) {
      if (deviceMode === "follower") {
        decisions.push({
          path,
          kind: "follower-preserve-before-delete",
          conflictPath: conflictPath(path, "local", now),
        });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-local-modified-remote-deleted",
        conflictPath: conflictPath(path, "local", now),
      });
    } else if (remoteFile) {
      if (deviceMode === "follower") {
        decisions.push({ path, kind: "follower-restore-deleted" });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-local-deleted-remote-modified",
        conflictPath: conflictPath(path, remoteSource, now),
      });
    }
  }

  return {
    baseCommitSha: base.baseCommitSha,
    remoteCommitSha,
    decisions,
    skipped: planSkipped,
    scanStats,
  };
}
