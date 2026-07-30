import type {
  CommitResult,
  LocalFileSnapshot,
  LocalIndex,
  LocalScanResult,
  LocalVault,
  RemoteMutation,
  RemoteRepository,
  RemoteSnapshot,
  SyncState,
} from "../src/types";
import { gitBlobSha, sha256, shouldExclude } from "../src/utils";

const encoder = new TextEncoder();

export class MemoryVault implements LocalVault {
  readonly files = new Map<string, Uint8Array>();
  readonly trashed: string[] = [];
  readonly readCounts = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();
  private clock = 1;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, encoder.encode(content));
      this.mtimes.set(path, this.clock++);
    }
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  setText(path: string, text: string): void {
    this.files.set(path, encoder.encode(text));
    this.mtimes.set(path, this.clock++);
  }

  async scan(
    maxFileSizeBytes: number,
    excludePatterns: string[],
    localIndex: LocalIndex,
  ): Promise<LocalScanResult> {
    const files = new Map<string, LocalFileSnapshot>();
    const index: LocalIndex = {};
    const skipped: string[] = [];
    let read = 0;
    let reused = 0;
    for (const [path, bytes] of this.files) {
      if (shouldExclude(path, excludePatterns)) continue;
      if (bytes.length > maxFileSizeBytes) {
        skipped.push(path);
        continue;
      }
      const mtime = this.mtimes.get(path) ?? 0;
      const cached = localIndex[path];
      if (cached?.size === bytes.length && cached.mtime === mtime) {
        files.set(path, {
          path,
          gitSha: cached.blobSha,
          sha256: cached.sha256,
          size: cached.size,
          mtime: cached.mtime,
        });
        index[path] = cached;
        reused += 1;
        continue;
      }
      const content = await this.read(path);
      const snapshot: LocalFileSnapshot = {
        path,
        bytes: content,
        gitSha: await gitBlobSha(content),
        sha256: await sha256(content),
        size: content.length,
        mtime,
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
    return {
      files,
      index,
      skipped,
      stats: { enumerated: files.size + skipped.length, read, reused },
    };
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Unknown local file ${path}`);
    this.readCounts.set(path, (this.readCounts.get(path) ?? 0) + 1);
    return new Uint8Array(bytes);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes));
    this.mtimes.set(path, this.clock++);
  }

  async trash(path: string): Promise<void> {
    if (this.files.delete(path)) {
      this.mtimes.delete(path);
      this.trashed.push(path);
    }
  }
}

export class MemoryRemote implements RemoteRepository {
  private readonly files = new Map<string, { bytes: Uint8Array; sha: string }>();
  private readonly blobs = new Map<string, Uint8Array>();
  private revision = 0;
  private head: string | null = null;
  failNextCommit = false;
  fullSnapshotReads = 0;

  async seed(initial: Record<string, string>): Promise<void> {
    for (const [path, value] of Object.entries(initial)) {
      const bytes = encoder.encode(value);
      const sha = await gitBlobSha(bytes);
      this.files.set(path, { bytes, sha });
      this.blobs.set(sha, bytes);
    }
    this.revision += 1;
    this.head = `commit-${this.revision}`;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.revision += 1;
    this.head = `commit-${this.revision}`;
  }

  async testConnection(): Promise<void> {}

  async getSnapshot(knownState?: SyncState): Promise<RemoteSnapshot> {
    if (knownState?.baseCommitSha === this.head && this.head !== null) {
      return {
        commitSha: this.head,
        treeSha: null,
        files: new Map(
          Object.entries(knownState.entries).map(([path, entry]) => [
            path,
            { path, sha: entry.blobSha, size: entry.size },
          ]),
        ),
      };
    }
    this.fullSnapshotReads += 1;
    return {
      commitSha: this.head,
      treeSha: this.head ? `tree-${this.revision}` : null,
      files: new Map(
        [...this.files].map(([path, file]) => [
          path,
          { path, sha: file.sha, size: file.bytes.length },
        ]),
      ),
    };
  }

  async readBlob(sha: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(sha);
    if (!bytes) throw new Error(`Unknown blob ${sha}`);
    return new Uint8Array(bytes);
  }

  async commit(
    expectedHead: string | null,
    mutations: RemoteMutation[],
    _message: string,
  ): Promise<CommitResult> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("Remote branch changed during sync; retry required");
    }
    if (expectedHead !== this.head) throw new Error("Expected head mismatch");
    for (const mutation of mutations) {
      if (mutation.kind === "delete") {
        this.files.delete(mutation.path);
      } else if (mutation.kind === "reuse") {
        const bytes = this.blobs.get(mutation.sha);
        if (!bytes) throw new Error(`Unknown reused blob ${mutation.sha}`);
        this.files.set(mutation.path, { bytes, sha: mutation.sha });
      } else {
        const bytes = new Uint8Array(mutation.bytes);
        const sha = await gitBlobSha(bytes);
        this.blobs.set(sha, bytes);
        this.files.set(mutation.path, { bytes, sha });
      }
    }
    this.revision += 1;
    this.head = `commit-${this.revision}`;
    return { commitSha: this.head, snapshot: await this.getSnapshot() };
  }
}
