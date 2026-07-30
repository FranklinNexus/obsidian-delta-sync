export type SyncPhase = "idle" | "scanning" | "downloading" | "uploading" | "conflict" | "failed";

export type DeviceMode = "writer" | "follower";

export interface SyncSettings {
  owner: string;
  repository: string;
  branch: string;
  deviceName: string;
  deviceMode: DeviceMode;
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

export interface ReleaseAssetReference {
  releaseId: number;
  assetId: number;
  name: string;
}

export interface RemoteStateEntry extends BaseEntry {
  asset?: ReleaseAssetReference;
}

export interface LocalIndexEntry extends BaseEntry {
  mtime: number;
}

export type LocalIndex = Record<string, LocalIndexEntry>;

export interface SyncState {
  baseCommitSha: string | null;
  entries: Record<string, RemoteStateEntry>;
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
  localIndex: LocalIndex;
  logs: SyncLogEntry[];
}

export interface LocalFileSnapshot {
  path: string;
  bytes?: Uint8Array;
  gitSha: string;
  sha256: string;
  size: number;
  mtime: number;
}

export interface LocalScanStats {
  enumerated: number;
  read: number;
  reused: number;
}

export interface LocalScanResult {
  files: Map<string, LocalFileSnapshot>;
  index: LocalIndex;
  skipped: string[];
  stats: LocalScanStats;
}

export interface RemoteFileSnapshot {
  path: string;
  sha: string;
  size: number;
  asset?: ReleaseAssetReference;
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
  | "follower-replace-remote"
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
  scanStats: LocalScanStats;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  localFilesRead: number;
  localFilesReused: number;
}

export type RemoteMutation =
  | { path: string; kind: "put"; bytes: Uint8Array; sha?: string }
  | {
      path: string;
      kind: "reuse";
      sha: string;
      size?: number;
      asset?: ReleaseAssetReference;
    }
  | { path: string; kind: "delete" };

export interface CommitResult {
  commitSha: string;
  snapshot: RemoteSnapshot;
}

export interface RemoteRepository {
  testConnection(): Promise<void>;
  getSnapshot(knownState?: SyncState): Promise<RemoteSnapshot>;
  readBlob(file: RemoteFileSnapshot): Promise<Uint8Array>;
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
    localIndex: LocalIndex,
  ): Promise<LocalScanResult>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface SyncRunResult {
  plan: SyncPlan;
  summary: SyncSummary;
  commitSha: string | null;
  nextState: SyncState;
  nextLocalIndex: LocalIndex;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  owner: "",
  repository: "",
  branch: "main",
  deviceName: "",
  deviceMode: "writer",
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

export const EMPTY_LOCAL_INDEX: LocalIndex = {};
