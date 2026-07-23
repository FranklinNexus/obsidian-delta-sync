import { requestUrl } from "obsidian";
import type {
  CommitResult,
  RemoteFileSnapshot,
  RemoteMutation,
  RemoteRepository,
  RemoteSnapshot,
} from "./types";
import { base64ToBytes, bytesToBase64 } from "./utils";

export interface TransportResponse {
  status: number;
  json: unknown;
  text: string;
}

export interface RequestTransport {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<TransportResponse>;
}

export class ObsidianRequestTransport implements RequestTransport {
  async request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<TransportResponse> {
    const response = await requestUrl({
      url: options.url,
      method: options.method,
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      throw: false,
    });
    return {
      status: response.status,
      json: response.json as unknown,
      text: response.text,
    };
  }
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubClientOptions {
  owner: string;
  repository: string;
  branch: string;
  token: string;
  transport?: RequestTransport;
}

interface GitHubRef {
  object: { sha: string };
}

interface GitHubCommit {
  sha: string;
  tree: { sha: string };
}

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeItem[];
}

interface GitHubBlob {
  sha: string;
  content: string;
  encoding: string;
}

const BLOB_UPLOAD_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid GitHub response for ${context}`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`Invalid GitHub response for ${context}`);
  return value;
}

function parseRef(value: unknown): GitHubRef {
  const root = objectValue(value, "reference");
  const object = objectValue(root.object, "reference object");
  return { object: { sha: stringValue(object.sha, "reference sha") } };
}

function parseCommit(value: unknown): GitHubCommit {
  const root = objectValue(value, "commit");
  const tree = objectValue(root.tree, "commit tree");
  return {
    sha: stringValue(root.sha, "commit sha"),
    tree: { sha: stringValue(tree.sha, "tree sha") },
  };
}

function parseTree(value: unknown): GitHubTree {
  const root = objectValue(value, "tree");
  if (!Array.isArray(root.tree)) throw new Error("Invalid GitHub response for tree items");
  return {
    sha: stringValue(root.sha, "tree sha"),
    truncated: root.truncated === true,
    tree: root.tree.map((item) => {
      const entry = objectValue(item, "tree item");
      const size = typeof entry.size === "number" ? entry.size : undefined;
      return {
        path: stringValue(entry.path, "tree path"),
        mode: stringValue(entry.mode, "tree mode"),
        type: stringValue(entry.type, "tree type"),
        sha: stringValue(entry.sha, "tree item sha"),
        ...(size === undefined ? {} : { size }),
      };
    }),
  };
}

function parseBlob(value: unknown): GitHubBlob {
  const root = objectValue(value, "blob");
  return {
    sha: stringValue(root.sha, "blob sha"),
    content: stringValue(root.content, "blob content"),
    encoding: stringValue(root.encoding, "blob encoding"),
  };
}

export class GitHubClient implements RemoteRepository {
  private readonly transport: RequestTransport;
  private readonly apiRoot: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.transport = options.transport ?? new ObsidianRequestTransport();
    this.apiRoot = `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}`;
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<TransportResponse> {
    const response = await this.transport.request({
      url: `${this.apiRoot}${path}`,
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) {
      let message = response.text || `GitHub request failed with status ${response.status}`;
      if (
        typeof response.json === "object" &&
        response.json !== null &&
        "message" in response.json
      ) {
        const apiMessage = (response.json as { message?: unknown }).message;
        if (typeof apiMessage === "string") message = apiMessage;
      }
      throw new GitHubApiError(message, response.status);
    }
    return response;
  }

  private branchPath(): string {
    return this.options.branch.split("/").map(encodeURIComponent).join("/");
  }

  async testConnection(): Promise<void> {
    await this.request("");
    try {
      await this.getHead();
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
  }

  private async getHead(): Promise<string | null> {
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const response = await this.request(
        `/git/ref/heads/${this.branchPath()}?sync_nonce=${encodeURIComponent(nonce)}`,
      );
      return parseRef(response.json).object.sha;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getSnapshot(): Promise<RemoteSnapshot> {
    const head = await this.getHead();
    if (head === null) return { commitSha: null, treeSha: null, files: new Map() };
    return this.getSnapshotAt(head);
  }

  private async getSnapshotAt(head: string): Promise<RemoteSnapshot> {
    const commitResponse = await this.request(`/git/commits/${encodeURIComponent(head)}`);
    const commit = parseCommit(commitResponse.json);
    const treeResponse = await this.request(
      `/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
    );
    const tree = parseTree(treeResponse.json);
    if (tree.truncated) {
      throw new Error("GitHub returned a truncated tree; narrow the sync scope before continuing");
    }
    const files = new Map<string, RemoteFileSnapshot>();
    for (const item of tree.tree) {
      if (item.type !== "blob") continue;
      files.set(item.path, { path: item.path, sha: item.sha, size: item.size ?? 0 });
    }
    return { commitSha: commit.sha, treeSha: tree.sha, files };
  }

  async readBlob(sha: string): Promise<Uint8Array> {
    const response = await this.request(`/git/blobs/${encodeURIComponent(sha)}`);
    const blob = parseBlob(response.json);
    if (blob.encoding !== "base64")
      throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
    return base64ToBytes(blob.content);
  }

  private async createBlob(bytes: Uint8Array): Promise<string> {
    const response = await this.request("/git/blobs", "POST", {
      content: bytesToBase64(bytes),
      encoding: "base64",
    });
    return stringValue(objectValue(response.json, "created blob").sha, "created blob sha");
  }

  async commit(
    expectedHead: string | null,
    mutations: RemoteMutation[],
    message: string,
  ): Promise<CommitResult> {
    const currentHead = await this.getHead();
    if (currentHead !== expectedHead) {
      throw new GitHubApiError("Remote branch changed during sync; retry required", 409);
    }

    let baseTree: string | null = null;
    if (expectedHead !== null) {
      const commitResponse = await this.request(`/git/commits/${encodeURIComponent(expectedHead)}`);
      baseTree = parseCommit(commitResponse.json).tree.sha;
    }

    const entries = await mapWithConcurrency(
      mutations,
      BLOB_UPLOAD_CONCURRENCY,
      async (mutation): Promise<Record<string, unknown>> => {
        if (mutation.kind === "delete") {
          return { path: mutation.path, mode: "100644", type: "blob", sha: null };
        }
        if (mutation.kind === "reuse") {
          return { path: mutation.path, mode: "100644", type: "blob", sha: mutation.sha };
        }
        const sha = await this.createBlob(mutation.bytes);
        return { path: mutation.path, mode: "100644", type: "blob", sha };
      },
    );

    if (entries.length === 0) {
      return { commitSha: expectedHead ?? "", snapshot: await this.getSnapshot() };
    }

    const treeBody: Record<string, unknown> = { tree: entries };
    if (baseTree !== null) treeBody.base_tree = baseTree;
    const treeResponse = await this.request("/git/trees", "POST", treeBody);
    const treeSha = stringValue(
      objectValue(treeResponse.json, "created tree").sha,
      "created tree sha",
    );

    const commitBody: Record<string, unknown> = {
      message,
      tree: treeSha,
      parents: expectedHead === null ? [] : [expectedHead],
    };
    const commitResponse = await this.request("/git/commits", "POST", commitBody);
    const commitSha = stringValue(
      objectValue(commitResponse.json, "created commit").sha,
      "created commit sha",
    );

    if (expectedHead === null) {
      await this.request("/git/refs", "POST", {
        ref: `refs/heads/${this.options.branch}`,
        sha: commitSha,
      });
    } else {
      await this.request(`/git/refs/heads/${this.branchPath()}`, "PATCH", {
        sha: commitSha,
        force: false,
      });
    }

    return { commitSha, snapshot: await this.getSnapshotAt(commitSha) };
  }
}
