import type {
  CommitResult,
  LocalFileSnapshot,
  LocalVault,
  RemoteMutation,
  RemoteRepository,
  RemoteSnapshot,
} from "../src/types";
import { gitBlobSha, sha256, shouldExclude } from "../src/utils";

const encoder = new TextEncoder();

export class MemoryVault implements LocalVault {
  readonly files = new Map<string, Uint8Array>();
  readonly trashed: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial))
      this.files.set(path, encoder.encode(content));
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  setText(path: string, text: string): void {
    this.files.set(path, encoder.encode(text));
  }

  async scan(
    maxFileSizeBytes: number,
    excludePatterns: string[],
  ): Promise<{ files: Map<string, LocalFileSnapshot>; skipped: string[] }> {
    const files = new Map<string, LocalFileSnapshot>();
    const skipped: string[] = [];
    for (const [path, bytes] of this.files) {
      if (shouldExclude(path, excludePatterns)) continue;
      if (bytes.length > maxFileSizeBytes) {
        skipped.push(path);
        continue;
      }
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

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes));
  }

  async trash(path: string): Promise<void> {
    if (this.files.delete(path)) this.trashed.push(path);
  }
}

export class MemoryRemote implements RemoteRepository {
  private readonly files = new Map<string, { bytes: Uint8Array; sha: string }>();
  private readonly blobs = new Map<string, Uint8Array>();
  private revision = 0;
  private head: string | null = null;
  failNextCommit = false;

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

  async testConnection(): Promise<void> {}

  async getSnapshot(): Promise<RemoteSnapshot> {
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
