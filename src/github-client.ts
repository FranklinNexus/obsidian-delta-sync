import { requestUrl } from "obsidian";
import type {
  CommitResult,
  RemoteFileSnapshot,
  RemoteMutation,
  RemoteRepository,
  RemoteSnapshot,
  ReleaseAssetReference,
  SyncState,
} from "./types";
import {
  base64ToBytes,
  bytesToBase64,
  gitBlobSha,
  inlineTreeContent,
  needsReleaseAsset,
} from "./utils";

export interface TransportResponse {
  status: number;
  json: unknown;
  text: string;
  arrayBuffer?: ArrayBuffer;
}

export interface RequestTransport {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    raw?: boolean;
  }): Promise<TransportResponse>;
}

export class ObsidianRequestTransport implements RequestTransport {
  async request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    raw?: boolean;
  }): Promise<TransportResponse> {
    const response = await requestUrl({
      url: options.url,
      method: options.method,
      headers: options.headers,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options.body === undefined ? {} : { body: options.body }),
      throw: false,
    });
    if (options.raw && response.status >= 200 && response.status < 300) {
      return {
        status: response.status,
        json: null,
        text: "",
        arrayBuffer: response.arrayBuffer,
      };
    }
    return { status: response.status, json: response.json as unknown, text: response.text };
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

interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
}

interface GitHubRelease {
  id: number;
  tagName: string;
  assets: GitHubReleaseAsset[];
}

interface AssetManifestEntry {
  sha: string;
  size: number;
  asset: ReleaseAssetReference;
}

type AssetManifest = Map<string, AssetManifestEntry>;

const BLOB_UPLOAD_CONCURRENCY = 1;
const BLOB_UPLOAD_INTERVAL_MS = 1_250;
const BLOB_UPLOAD_MAX_ATTEMPTS = 5;
const SECONDARY_RATE_LIMIT_COOLDOWN_MS = 60_000;
const TRANSIENT_ERROR_INITIAL_COOLDOWN_MS = 15_000;
const TRANSIENT_ERROR_MAX_COOLDOWN_MS = 120_000;
const MAX_MUTATIONS_PER_TRANSACTION_COMMIT = 100;
const MAX_INLINE_TREE_BODY_BYTES = 512 * 1024;
const ASSET_MANIFEST_PATH = ".delta-sync-assets.json";
const ASSET_RELEASE_TAG_PREFIX = "delta-sync-assets-v";
const ASSET_RELEASE_MAX_ASSETS = 900;
const RELEASE_ASSET_UPLOAD_CONCURRENCY = 3;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function transactionBatches(mutations: RemoteMutation[]): RemoteMutation[][] {
  const batches: RemoteMutation[][] = [];
  let batch: RemoteMutation[] = [];
  let inlineBytes = 0;

  for (const mutation of mutations) {
    const nextInlineBytes =
      mutation.kind === "put" && inlineTreeContent(mutation.bytes) !== null
        ? mutation.bytes.byteLength
        : 0;
    const exceedsEntryLimit = batch.length >= MAX_MUTATIONS_PER_TRANSACTION_COMMIT;
    const exceedsBodyLimit =
      batch.length > 0 && inlineBytes + nextInlineBytes > MAX_INLINE_TREE_BODY_BYTES;
    if (exceedsEntryLimit || exceedsBodyLimit) {
      batches.push(batch);
      batch = [];
      inlineBytes = 0;
    }
    batch.push(mutation);
    inlineBytes += nextInlineBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

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

function numberValue(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid GitHub response for ${context}`);
  }
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

function parseReleaseAsset(value: unknown): GitHubReleaseAsset {
  const root = objectValue(value, "release asset");
  return {
    id: numberValue(root.id, "release asset id"),
    name: stringValue(root.name, "release asset name"),
    size: numberValue(root.size, "release asset size"),
  };
}

function parseRelease(value: unknown): GitHubRelease {
  const root = objectValue(value, "release");
  if (!Array.isArray(root.assets)) throw new Error("Invalid GitHub response for release assets");
  return {
    id: numberValue(root.id, "release id"),
    tagName: stringValue(root.tag_name, "release tag name"),
    assets: root.assets.map(parseReleaseAsset),
  };
}

function parseReleaseAssetList(value: unknown): GitHubReleaseAsset[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub response for release asset list");
  return value.map(parseReleaseAsset);
}

function parseAssetReference(value: unknown): ReleaseAssetReference {
  const root = objectValue(value, "asset reference");
  return {
    releaseId: numberValue(root.releaseId, "asset reference release id"),
    assetId: numberValue(root.assetId, "asset reference asset id"),
    name: stringValue(root.name, "asset reference name"),
  };
}

function parseAssetManifest(bytes: Uint8Array): AssetManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Delta Sync asset manifest is invalid JSON");
  }
  const root = objectValue(decoded, "asset manifest");
  if (root.version !== 1) throw new Error("Unsupported Delta Sync asset manifest version");
  const files = objectValue(root.files, "asset manifest files");
  const entries: AssetManifest = new Map();
  for (const [path, value] of Object.entries(files)) {
    const entry = objectValue(value, `asset manifest file ${path}`);
    entries.set(path, {
      sha: stringValue(entry.sha, `asset manifest SHA for ${path}`),
      size: numberValue(entry.size, `asset manifest size for ${path}`),
      asset: parseAssetReference(entry.asset),
    });
  }
  return entries;
}

function serializeAssetManifest(entries: AssetManifest): Uint8Array {
  const files = Object.fromEntries(
    [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, entry]) => [path, entry]),
  );
  return new TextEncoder().encode(JSON.stringify({ version: 1, files }, null, 2) + "\n");
}

function repositoryDefaultBranch(value: unknown): string {
  return stringValue(objectValue(value, "repository").default_branch, "repository default branch");
}

export class GitHubClient implements RemoteRepository {
  private readonly transport: RequestTransport;
  private readonly apiRoot: string;
  private readonly uploadsRoot: string;
  private nextBlobUploadAt = 0;
  private assetUploadSequence = 0;

  constructor(private readonly options: GitHubClientOptions) {
    this.transport = options.transport ?? new ObsidianRequestTransport();
    this.apiRoot = `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}`;
    this.uploadsRoot = `https://uploads.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}`;
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    accept = "application/vnd.github+json",
    requestOptions: {
      url?: string;
      raw?: boolean;
      contentType?: string;
    } = {},
  ): Promise<TransportResponse> {
    const isBinaryBody = body instanceof ArrayBuffer;
    const response = await this.transport.request({
      url: requestOptions.url ?? `${this.apiRoot}${path}`,
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": requestOptions.contentType ?? "application/json",
        "Cache-Control": "no-cache",
      },
      ...(body === undefined ? {} : { body: isBinaryBody ? body : JSON.stringify(body) }),
      contentType: requestOptions.contentType ?? "application/json",
      ...(requestOptions.raw || accept === "application/vnd.github.raw+json" ? { raw: true } : {}),
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

  private branchPath(branch = this.options.branch): string {
    return branch.split("/").map(encodeURIComponent).join("/");
  }

  private contentsPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  async testConnection(): Promise<void> {
    await this.request("");
    try {
      await this.getHead();
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
  }

  private async getHeadForBranch(branch: string): Promise<string | null> {
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const response = await this.request(
        `/git/ref/heads/${this.branchPath(branch)}?sync_nonce=${encodeURIComponent(nonce)}`,
      );
      return parseRef(response.json).object.sha;
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 ||
          (error.status === 409 && error.message === "Git Repository is empty."))
      ) {
        return null;
      }
      throw error;
    }
  }

  private async getHead(): Promise<string | null> {
    return this.getHeadForBranch(this.options.branch);
  }

  private async getDefaultBranch(): Promise<string> {
    return repositoryDefaultBranch((await this.request("")).json);
  }

  async getSnapshot(knownState?: SyncState): Promise<RemoteSnapshot> {
    const head = await this.getHead();
    if (head === null) return { commitSha: null, treeSha: null, files: new Map() };
    if (knownState?.baseCommitSha === head) {
      return {
        commitSha: head,
        treeSha: null,
        files: new Map(
          Object.entries(knownState.entries).map(([path, entry]) => [
            path,
            {
              path,
              sha: entry.blobSha,
              size: entry.size,
              ...(entry.asset ? { asset: entry.asset } : {}),
            },
          ]),
        ),
      };
    }
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
    const manifestItem = tree.tree.find(
      (item) => item.type === "blob" && item.path === ASSET_MANIFEST_PATH,
    );
    const assetManifest = manifestItem
      ? parseAssetManifest(await this.readGitBlob(manifestItem.sha))
      : new Map<string, AssetManifestEntry>();
    for (const item of tree.tree) {
      if (item.type !== "blob" || item.path === ASSET_MANIFEST_PATH) continue;
      files.set(item.path, { path: item.path, sha: item.sha, size: item.size ?? 0 });
    }
    for (const [path, entry] of assetManifest) {
      if (files.has(path)) {
        throw new Error(`Delta Sync asset manifest conflicts with Git file: ${path}`);
      }
      files.set(path, {
        path,
        sha: entry.sha,
        size: entry.size,
        asset: entry.asset,
      });
    }
    return { commitSha: commit.sha, treeSha: tree.sha, files };
  }

  private async readGitBlob(sha: string): Promise<Uint8Array> {
    const response = await this.request(
      `/git/blobs/${encodeURIComponent(sha)}`,
      "GET",
      undefined,
      "application/vnd.github.raw+json",
    );
    if (response.arrayBuffer) return new Uint8Array(response.arrayBuffer);
    const blob = parseBlob(response.json);
    if (blob.encoding !== "base64")
      throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
    return base64ToBytes(blob.content);
  }

  private async readReleaseAsset(asset: ReleaseAssetReference): Promise<Uint8Array> {
    const response = await this.request(
      `/releases/assets/${encodeURIComponent(String(asset.assetId))}`,
      "GET",
      undefined,
      "application/octet-stream",
      { raw: true },
    );
    if (!response.arrayBuffer) throw new Error(`GitHub did not return bytes for ${asset.name}`);
    return new Uint8Array(response.arrayBuffer);
  }

  async readBlob(file: RemoteFileSnapshot): Promise<Uint8Array> {
    return file.asset ? this.readReleaseAsset(file.asset) : this.readGitBlob(file.sha);
  }

  private async waitForBlobUploadSlot(): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextBlobUploadAt);
    this.nextBlobUploadAt = scheduledAt + BLOB_UPLOAD_INTERVAL_MS;
    const delay = scheduledAt - now;
    if (delay > 0) await pause(delay);
  }

  private isSecondaryRateLimit(error: unknown): error is GitHubApiError {
    return error instanceof GitHubApiError && /secondary rate limit/iu.test(error.message);
  }

  private isRetryableBlobUploadError(error: unknown): boolean {
    if (error instanceof GitHubApiError) {
      return (
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500 ||
        /couldn't respond to your request in time|timeout|temporarily unavailable/iu.test(
          error.message,
        )
      );
    }
    return (
      error instanceof Error && /network|timeout|temporarily unavailable/iu.test(error.message)
    );
  }

  private blobRetryCooldown(error: unknown, attempt: number): number {
    if (this.isSecondaryRateLimit(error)) return SECONDARY_RATE_LIMIT_COOLDOWN_MS;
    return Math.min(
      TRANSIENT_ERROR_INITIAL_COOLDOWN_MS * 2 ** attempt,
      TRANSIENT_ERROR_MAX_COOLDOWN_MS,
    );
  }

  private async createBlob(bytes: Uint8Array): Promise<string> {
    for (let attempt = 0; attempt < BLOB_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      await this.waitForBlobUploadSlot();
      try {
        const response = await this.request("/git/blobs", "POST", {
          content: bytesToBase64(bytes),
          encoding: "base64",
        });
        return stringValue(objectValue(response.json, "created blob").sha, "created blob sha");
      } catch (error) {
        if (attempt === BLOB_UPLOAD_MAX_ATTEMPTS - 1 || !this.isRetryableBlobUploadError(error)) {
          throw error;
        }
        this.nextBlobUploadAt = Math.max(
          this.nextBlobUploadAt,
          Date.now() + this.blobRetryCooldown(error, attempt),
        );
      }
    }
    throw new Error("Blob upload retry limit was reached");
  }

  private async getAssetRelease(tagName: string): Promise<GitHubRelease | null> {
    try {
      return parseRelease(
        (
          await this.request(
            `/releases/tags/${encodeURIComponent(tagName)}`,
            "GET",
            undefined,
            "application/vnd.github+json",
          )
        ).json,
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async createAssetRelease(tagName: string): Promise<GitHubRelease> {
    return parseRelease(
      (
        await this.request("/releases", "POST", {
          tag_name: tagName,
          name: "Delta Sync attachments",
          generate_release_notes: false,
          draft: false,
          prerelease: false,
        })
      ).json,
    );
  }

  private async releaseAssetCount(releaseId: number): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 10; page += 1) {
      const assets = parseReleaseAssetList(
        (
          await this.request(
            `/releases/${encodeURIComponent(String(releaseId))}/assets?per_page=100&page=${page}`,
          )
        ).json,
      );
      total += assets.length;
      if (assets.length < 100) return total;
    }
    return total;
  }

  private async assetRelease(requiredSlots: number): Promise<GitHubRelease> {
    if (requiredSlots > ASSET_RELEASE_MAX_ASSETS) {
      throw new Error("Too many attachments in one sync transaction");
    }
    for (let bucket = 1; ; bucket += 1) {
      const tagName = `${ASSET_RELEASE_TAG_PREFIX}${bucket}`;
      const existing = await this.getAssetRelease(tagName);
      if (existing) {
        const assetCount = await this.releaseAssetCount(existing.id);
        if (assetCount + requiredSlots <= ASSET_RELEASE_MAX_ASSETS) return existing;
      }
      if (!existing) return this.createAssetRelease(tagName);
    }
  }

  private async uploadReleaseAsset(
    release: GitHubRelease,
    sha: string,
    bytes: Uint8Array,
  ): Promise<ReleaseAssetReference> {
    for (let attempt = 0; attempt < BLOB_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      this.assetUploadSequence += 1;
      const name = `asset-${sha}-${Date.now().toString(36)}-${this.assetUploadSequence}`;
      const uploadUrl = `${this.uploadsRoot}/releases/${encodeURIComponent(String(release.id))}/assets?name=${encodeURIComponent(name)}`;
      try {
        const body = bytes.slice().buffer;
        const response = await this.request("", "POST", body, "application/vnd.github+json", {
          url: uploadUrl,
          contentType: "application/octet-stream",
        });
        const asset = parseReleaseAsset(response.json);
        return { releaseId: release.id, assetId: asset.id, name: asset.name };
      } catch (error) {
        if (attempt === BLOB_UPLOAD_MAX_ATTEMPTS - 1 || !this.isRetryableBlobUploadError(error)) {
          throw error;
        }
        await pause(this.blobRetryCooldown(error, attempt));
      }
    }
    throw new Error("Release Asset upload retry limit was reached");
  }

  private async prepareAssetMutations(
    baseSnapshot: RemoteSnapshot,
    mutations: RemoteMutation[],
  ): Promise<RemoteMutation[]> {
    const assets: AssetManifest = new Map(
      [...baseSnapshot.files]
        .filter(([, file]) => file.asset)
        .map(([path, file]) => {
          if (!file.asset) throw new Error(`Missing asset reference for ${path}`);
          return [path, { sha: file.sha, size: file.size, asset: file.asset }] as const;
        }),
    );
    const hadAssets = assets.size > 0;
    const assetsBySha = new Map<string, ReleaseAssetReference>();
    for (const entry of assets.values()) assetsBySha.set(entry.sha, entry.asset);

    const externalPuts: { mutation: Extract<RemoteMutation, { kind: "put" }>; sha: string }[] = [];
    for (const mutation of mutations) {
      if (mutation.kind !== "put" || !needsReleaseAsset(mutation.bytes)) continue;
      externalPuts.push({ mutation, sha: mutation.sha ?? (await gitBlobSha(mutation.bytes)) });
    }
    const pendingAssets = new Map<string, Uint8Array>();
    for (const { mutation, sha } of externalPuts) {
      if (!assetsBySha.has(sha)) pendingAssets.set(sha, mutation.bytes);
    }
    if (pendingAssets.size > 0) {
      const release = await this.assetRelease(pendingAssets.size);
      const uploaded = await mapWithConcurrency(
        [...pendingAssets],
        RELEASE_ASSET_UPLOAD_CONCURRENCY,
        async ([sha, bytes]) => [sha, await this.uploadReleaseAsset(release, sha, bytes)] as const,
      );
      for (const [sha, asset] of uploaded) assetsBySha.set(sha, asset);
    }

    const treeMutations: RemoteMutation[] = [];
    const externalPutsByPath = new Map(
      externalPuts.map(({ mutation, sha }) => [mutation.path, { mutation, sha }]),
    );
    for (const mutation of mutations) {
      const baseFile = baseSnapshot.files.get(mutation.path);
      if (mutation.kind === "delete") {
        assets.delete(mutation.path);
        if (baseFile && !baseFile.asset) treeMutations.push(mutation);
        continue;
      }
      if (mutation.kind === "reuse" && mutation.asset) {
        if (mutation.size === undefined) {
          throw new Error(`Missing size for asset-backed reuse: ${mutation.path}`);
        }
        assets.set(mutation.path, {
          sha: mutation.sha,
          size: mutation.size,
          asset: mutation.asset,
        });
        if (baseFile && !baseFile.asset)
          treeMutations.push({ path: mutation.path, kind: "delete" });
        continue;
      }
      const externalPut = externalPutsByPath.get(mutation.path);
      if (externalPut) {
        const asset = assetsBySha.get(externalPut.sha);
        if (!asset) throw new Error(`Release Asset upload failed for ${mutation.path}`);
        assets.set(mutation.path, {
          sha: externalPut.sha,
          size: externalPut.mutation.bytes.byteLength,
          asset,
        });
        if (baseFile && !baseFile.asset)
          treeMutations.push({ path: mutation.path, kind: "delete" });
        continue;
      }
      assets.delete(mutation.path);
      treeMutations.push(mutation);
    }

    if (assets.size > 0) {
      treeMutations.push({
        path: ASSET_MANIFEST_PATH,
        kind: "put",
        bytes: serializeAssetManifest(assets),
      });
    } else if (hadAssets) {
      // The manifest is an implementation detail; removing it leaves no control file in the Vault.
      treeMutations.push({ path: ASSET_MANIFEST_PATH, kind: "delete" });
    }
    return treeMutations;
  }

  private async createCommitObject(
    parentCommit: string,
    baseTree: string,
    mutations: RemoteMutation[],
    message: string,
  ): Promise<{ commitSha: string; treeSha: string }> {
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
        const content = inlineTreeContent(mutation.bytes);
        if (content !== null) {
          return { path: mutation.path, mode: "100644", type: "blob", content };
        }
        const sha = await this.createBlob(mutation.bytes);
        return { path: mutation.path, mode: "100644", type: "blob", sha };
      },
    );

    const treeResponse = await this.request("/git/trees", "POST", {
      tree: entries,
      base_tree: baseTree,
    });
    const treeSha = stringValue(
      objectValue(treeResponse.json, "created tree").sha,
      "created tree sha",
    );
    const commitResponse = await this.request("/git/commits", "POST", {
      message,
      tree: treeSha,
      parents: [parentCommit],
    });
    return {
      commitSha: stringValue(
        objectValue(commitResponse.json, "created commit").sha,
        "created commit sha",
      ),
      treeSha,
    };
  }

  async commit(
    expectedHead: string | null,
    mutations: RemoteMutation[],
    message: string,
  ): Promise<CommitResult> {
    if (expectedHead === null) {
      const defaultBranch = await this.getDefaultBranch();
      if ((await this.getHead()) !== null) {
        throw new GitHubApiError("Remote branch changed during sync; retry required", 409);
      }
      const bootstrap =
        mutations.find(
          (mutation): mutation is Extract<RemoteMutation, { kind: "put" }> =>
            mutation.kind === "put" && !needsReleaseAsset(mutation.bytes),
        ) ??
        mutations.find(
          (mutation): mutation is Extract<RemoteMutation, { kind: "put" }> =>
            mutation.kind === "put",
        );
      if (!bootstrap) {
        throw new Error("Cannot initialize an empty repository without a local file to upload");
      }

      // GitHub cannot create refs through the Git Data API for an empty repository.
      // Seed the branch with a real vault file, then use the normal atomic commit path.
      await this.request(`/contents/${this.contentsPath(bootstrap.path)}`, "PUT", {
        message,
        content: bytesToBase64(bootstrap.bytes),
      });
      const defaultHead = await this.getHeadForBranch(defaultBranch);
      if (defaultHead === null) {
        throw new Error(
          "GitHub did not create its default branch while initializing the repository",
        );
      }
      if (defaultBranch !== this.options.branch) {
        await this.request("/git/refs", "POST", {
          ref: `refs/heads/${this.options.branch}`,
          sha: defaultHead,
        });
      }
      const initialized = await this.getSnapshot();
      if (initialized.commitSha === null) {
        throw new Error("GitHub did not create a branch while initializing the empty repository");
      }

      const remaining = mutations.filter(
        (mutation) => mutation !== bootstrap || needsReleaseAsset(bootstrap.bytes),
      );
      if (remaining.length === 0) {
        return { commitSha: initialized.commitSha, snapshot: initialized };
      }
      return this.commit(initialized.commitSha, remaining, message);
    }

    const currentHead = await this.getHead();
    if (currentHead !== expectedHead) {
      throw new GitHubApiError("Remote branch changed during sync; retry required", 409);
    }
    if (mutations.length === 0) {
      return { commitSha: expectedHead, snapshot: await this.getSnapshot() };
    }

    const baseSnapshot = await this.getSnapshotAt(expectedHead);
    if (baseSnapshot.treeSha === null) throw new Error("Remote branch is missing its Git tree");
    const preparedMutations = await this.prepareAssetMutations(baseSnapshot, mutations);
    if (preparedMutations.length === 0) {
      return { commitSha: expectedHead, snapshot: baseSnapshot };
    }
    let parentCommit = expectedHead;
    let baseTree = baseSnapshot.treeSha;
    for (const batch of transactionBatches(preparedMutations)) {
      const created = await this.createCommitObject(parentCommit, baseTree, batch, message);
      parentCommit = created.commitSha;
      baseTree = created.treeSha;
    }

    // Create all objects first. The sync branch advances once, so other devices never observe a partial tree.
    if ((await this.getHead()) !== expectedHead) {
      throw new GitHubApiError("Remote branch changed during sync; retry required", 409);
    }

    await this.request(`/git/refs/heads/${this.branchPath()}`, "PATCH", {
      sha: parentCommit,
      force: false,
    });

    return { commitSha: parentCommit, snapshot: await this.getSnapshotAt(parentCommit) };
  }
}
