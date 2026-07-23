export type SyncPhase = "idle" | "scanning" | "downloading" | "uploading" | "conflict" | "failed";

export interface SyncSettings {
  owner: string;
  repository: string;
  branch: string;
  deviceName: string;
  autoSync: boolean;
  intervalMinutes: number;
  maxFileSizeMb: number;
  excludePatterns: string[];
  firstSyncConfirmed: boolean;
  vaultInstanceId: string;
}

export interface BaseEntry {
  blobSha: string;
  sha256: string;
  size: number;
}

export interface SyncState {
  baseCommitSha: string | null;
  entries: Record<string, BaseEntry>;
}

export interface SyncLogEntry {
  timestamp: string;
  status: "success" | "failed" | "preview";
  message: string;
  commitSha?: string;
  summary?: SyncSummary;
}

export interface PluginData {
  settings: SyncSettings;
  syncState: SyncState;
  logs: SyncLogEntry[];
}

export interface LocalFileSnapshot {
  path: string;
  bytes: Uint8Array;
  gitSha: string;
  sha256: string;
  size: number;
}

export interface RemoteFileSnapshot {
  path: string;
  sha: string;
  size: number;
}

export interface RemoteSnapshot {
  commitSha: string | null;
  treeSha: string | null;
  files: Map<string, RemoteFileSnapshot>;
}

export type SyncDecisionKind =
  | "noop"
  | "upload-local"
  | "download-remote"
  | "delete-remote"
  | "delete-local"
  | "conflict-both-modified"
  | "conflict-local-modified-remote-deleted"
  | "conflict-local-deleted-remote-modified";

export interface SyncDecision {
  path: string;
  kind: SyncDecisionKind;
  conflictPath?: string;
}

export interface SyncPlan {
  baseCommitSha: string | null;
  remoteCommitSha: string | null;
  decisions: SyncDecision[];
  skipped: string[];
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
}

export type RemoteMutation =
  | { path: string; kind: "put"; bytes: Uint8Array }
  | { path: string; kind: "reuse"; sha: string }
  | { path: string; kind: "delete" };

export interface CommitResult {
  commitSha: string;
  snapshot: RemoteSnapshot;
}

export interface RemoteRepository {
  testConnection(): Promise<void>;
  getSnapshot(): Promise<RemoteSnapshot>;
  readBlob(sha: string): Promise<Uint8Array>;
  commit(
    expectedHead: string | null,
    mutations: RemoteMutation[],
    message: string,
  ): Promise<CommitResult>;
}

export interface LocalVault {
  scan(
    maxFileSizeBytes: number,
    excludePatterns: string[],
  ): Promise<{
    files: Map<string, LocalFileSnapshot>;
    skipped: string[];
  }>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface SyncRunResult {
  plan: SyncPlan;
  summary: SyncSummary;
  commitSha: string | null;
  nextState: SyncState;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  owner: "",
  repository: "",
  branch: "main",
  deviceName: "",
  autoSync: false,
  intervalMinutes: 5,
  maxFileSizeMb: 25,
  excludePatterns: [],
  firstSyncConfirmed: false,
  vaultInstanceId: "",
};

export const EMPTY_SYNC_STATE: SyncState = {
  baseCommitSha: null,
  entries: {},
};
