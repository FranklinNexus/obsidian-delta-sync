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
  _now = new Date(),
  deviceMode: DeviceMode = "writer",
  scanStats: LocalScanStats = { enumerated: local.size, read: local.size, reused: 0 },
): SyncPlan {
  void _now; // Retained for callers of the pre-content-addressed planner API.
  const decisions: SyncDecision[] = [];
  const planSkipped = [...skipped];
  const isFollower = deviceMode === "follower";
  // A retry must reuse the same backup, even if the branch head or clock changed.
  // Never overwrite a backup that the user has subsequently edited.
  const backupPath = (path: string, source: string, sha: string): string => {
    for (let suffix = 0; ; suffix += 1) {
      const candidate = conflictPath(path, source, `${sha}${suffix ? `-${suffix}` : ""}`);
      const localSha = local.get(candidate)?.gitSha;
      const remoteSha = remote.get(candidate)?.sha;
      if ((!localSha || localSha === sha) && (!remoteSha || remoteSha === sha)) return candidate;
    }
  };

  for (const path of allPaths(base, local, remote)) {
    const baseSha = base.entries[path]?.blobSha;
    const localFile = local.get(path);
    const remoteFile = remote.get(path);
    const localSha = localFile?.gitSha;
    const remoteSha = remoteFile?.sha;

    if (localFile && remoteFile && localSha === remoteSha) {
      decisions.push({ path, kind: "noop" });
      continue;
    }

    if (!localFile && !remoteFile) continue;

    const localChanged = localSha !== baseSha;
    const remoteChanged = remoteSha !== baseSha;

    if (localChanged && !remoteChanged) {
      if (isFollower) {
        if (localFile && remoteFile) {
          decisions.push({ path, kind: "follower-replace-remote" });
        } else if (!localFile && remoteFile) {
          decisions.push({ path, kind: "download-remote" });
        } else if (localFile) {
          decisions.push({ path, kind: "delete-local" });
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
      if (isFollower) {
        decisions.push({ path, kind: "follower-replace-remote" });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-both-modified",
        conflictPath: backupPath(path, "github", remoteFile.sha),
      });
    } else if (localFile) {
      if (isFollower) {
        decisions.push({ path, kind: "delete-local" });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-local-modified-remote-deleted",
        conflictPath: backupPath(path, "local", localFile.gitSha),
      });
    } else if (remoteFile) {
      if (isFollower) {
        decisions.push({ path, kind: "download-remote" });
        continue;
      }
      decisions.push({
        path,
        kind: "conflict-local-deleted-remote-modified",
        conflictPath: backupPath(path, "github", remoteFile.sha),
      });
    }
  }

  const backupPaths = new Set(
    decisions.flatMap((decision) => (decision.conflictPath ? [decision.conflictPath] : [])),
  );
  return {
    baseCommitSha: base.baseCommitSha,
    remoteCommitSha,
    decisions: decisions.filter((decision) => !backupPaths.has(decision.path)),
    skipped: planSkipped,
    scanStats,
  };
}
