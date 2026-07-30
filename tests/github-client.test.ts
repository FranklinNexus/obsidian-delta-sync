import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import {
  GitHubApiError,
  GitHubClient,
  type RequestTransport,
  type TransportResponse,
} from "../src/github-client";

class RecordingTransport implements RequestTransport {
  readonly requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    raw?: boolean;
  }[] = [];

  constructor(private readonly responses: TransportResponse[]) {}

  async request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    raw?: boolean;
  }): Promise<TransportResponse> {
    this.requests.push(options);
    const response = this.responses.shift();
    if (!response) throw new Error(`No scripted response for ${options.method} ${options.url}`);
    return response;
  }
}

function ok(json: unknown): TransportResponse {
  return { status: 200, json, text: JSON.stringify(json) };
}

function created(json: unknown): TransportResponse {
  return { status: 201, json, text: JSON.stringify(json) };
}

function failed(status: number, message: string): TransportResponse {
  return { status, json: { message }, text: message };
}

function raw(bytes: Uint8Array): TransportResponse {
  return {
    status: 200,
    json: {},
    text: "",
    arrayBuffer: new Uint8Array(bytes).buffer,
  };
}

describe("GitHubClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads a recursive Git tree", async () => {
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      ok({
        sha: "tree-1",
        truncated: false,
        tree: [
          { path: "note.md", mode: "100644", type: "blob", sha: "blob-1", size: 4 },
          { path: "Folder", mode: "040000", type: "tree", sha: "tree-2" },
        ],
      }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "feature/sync",
      token: "secret",
      transport,
    });
    const snapshot = await client.getSnapshot();
    expect(snapshot.commitSha).toBe("head-1");
    expect(snapshot.files.get("note.md")?.sha).toBe("blob-1");
    expect(transport.requests[0]?.url).toContain("/git/ref/heads/feature/sync");
    expect(transport.requests[0]?.url).toContain("sync_nonce=");
    expect(transport.requests[0]?.headers.Authorization).toBe("Bearer secret");
    expect(transport.requests[0]?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("reuses the known tree when the branch head is unchanged", async () => {
    const transport = new RecordingTransport([ok({ object: { sha: "head-1" } })]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    const snapshot = await client.getSnapshot({
      baseCommitSha: "head-1",
      entries: {
        "note.md": { blobSha: "blob-1", sha256: "sha256-1", size: 4 },
      },
    });

    expect(snapshot.files.get("note.md")?.sha).toBe("blob-1");
    expect(transport.requests).toHaveLength(1);
  });

  it("treats an empty GitHub repository as an empty remote snapshot", async () => {
    const transport = new RecordingTransport([
      failed(409, "Git Repository is empty."),
      ok({}),
      failed(409, "Git Repository is empty."),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });

    const snapshot = await client.getSnapshot();
    expect(snapshot).toMatchObject({ commitSha: null, treeSha: null });
    expect(snapshot.files).toHaveLength(0);
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("initializes an empty repository with a real vault file before committing the remainder", async () => {
    const transport = new RecordingTransport([
      ok({ default_branch: "main" }),
      failed(409, "Git Repository is empty."),
      created({ content: {}, commit: { sha: "head-initial" } }),
      ok({ object: { sha: "head-initial" } }),
      ok({}),
      ok({ object: { sha: "head-initial" } }),
      ok({ sha: "head-initial", tree: { sha: "tree-initial" } }),
      ok({
        sha: "tree-initial",
        truncated: false,
        tree: [{ path: "note.md", mode: "100644", type: "blob", sha: "blob-initial", size: 5 }],
      }),
      ok({ object: { sha: "head-initial" } }),
      ok({ sha: "head-initial", tree: { sha: "tree-initial" } }),
      created({ sha: "blob-second" }),
      created({ sha: "tree-final" }),
      created({ sha: "head-final" }),
      ok({ object: { sha: "head-initial" } }),
      ok({}),
      ok({ sha: "head-final", tree: { sha: "tree-final" } }),
      ok({
        sha: "tree-final",
        truncated: false,
        tree: [
          { path: "note.md", mode: "100644", type: "blob", sha: "blob-initial", size: 5 },
          { path: "second.md", mode: "100644", type: "blob", sha: "blob-second", size: 6 },
        ],
      }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "vault-sync",
      token: "secret",
      transport,
    });

    const result = await client.commit(
      null,
      [
        { path: "note.md", kind: "put", bytes: new TextEncoder().encode("first") },
        { path: "second.md", kind: "put", bytes: new TextEncoder().encode("second") },
      ],
      "Sync",
    );

    expect(result.commitSha).toBe("head-final");
    expect(result.snapshot.files).toHaveLength(2);
    const bootstrap = transport.requests.find((request) =>
      request.url.endsWith("/contents/note.md"),
    );
    expect(bootstrap?.method).toBe("PUT");
    expect(JSON.parse(bootstrap?.body ?? "{}")).toMatchObject({
      message: "Sync",
      content: "Zmlyc3Q=",
    });
    const branchCreation = transport.requests.find(
      (request) => request.url.endsWith("/git/refs") && request.method === "POST",
    );
    expect(JSON.parse(branchCreation?.body ?? "{}")).toEqual({
      ref: "refs/heads/vault-sync",
      sha: "head-initial",
    });
    const secondBlob = transport.requests.find(
      (request) => request.url.endsWith("/git/blobs") && request.method === "POST",
    );
    expect(JSON.parse(secondBlob?.body ?? "{}")).toMatchObject({ content: "c2Vjb25k" });
  });

  it("downloads blob bytes without base64 decoding when raw media is available", async () => {
    const transport = new RecordingTransport([raw(new Uint8Array([0, 128, 255]))]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });

    expect(await client.readBlob("blob-1")).toEqual(new Uint8Array([0, 128, 255]));
    expect(transport.requests[0]?.headers.Accept).toBe("application/vnd.github.raw+json");
  });

  it("updates the branch without force after creating a commit", async () => {
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      created({ sha: "blob-new" }),
      created({ sha: "tree-new" }),
      created({ sha: "head-2" }),
      ok({ object: { sha: "head-1" } }),
      ok({ object: { sha: "head-2" } }),
      ok({ sha: "head-2", tree: { sha: "tree-new" } }),
      ok({
        sha: "tree-new",
        truncated: false,
        tree: [{ path: "note.md", mode: "100644", type: "blob", sha: "blob-new", size: 5 }],
      }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    const result = await client.commit(
      "head-1",
      [{ path: "note.md", kind: "put", bytes: new TextEncoder().encode("hello") }],
      "Sync",
    );
    expect(result.commitSha).toBe("head-2");
    const refUpdate = transport.requests.find((request) => request.method === "PATCH");
    expect(refUpdate).toBeDefined();
    expect(JSON.parse(refUpdate?.body ?? "{}")).toEqual({ sha: "head-2", force: false });
    expect(
      transport.requests.filter((request) => request.url.endsWith("/git/commits")),
    ).toHaveLength(1);
  });

  it("retries a transient blob upload failure with backoff", async () => {
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      callback();
      return 0;
    });
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      failed(500, "We couldn't respond to your request in time."),
      created({ sha: "blob-new" }),
      created({ sha: "tree-new" }),
      created({ sha: "head-2" }),
      ok({ object: { sha: "head-1" } }),
      ok({}),
      ok({ sha: "head-2", tree: { sha: "tree-new" } }),
      ok({ sha: "tree-new", truncated: false, tree: [] }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });

    await expect(
      client.commit(
        "head-1",
        [{ path: "note.md", kind: "put", bytes: new TextEncoder().encode("hello") }],
        "Sync",
      ),
    ).resolves.toMatchObject({ commitSha: "head-2" });
    expect(transport.requests.filter((request) => request.url.endsWith("/git/blobs"))).toHaveLength(
      2,
    );
    vi.unstubAllGlobals();
  });

  it("builds large syncs in batches before advancing the branch", async () => {
    const transport = new RecordingTransport([
      ok({ object: { sha: "head-1" } }),
      ok({ sha: "head-1", tree: { sha: "tree-1" } }),
      created({ sha: "tree-2" }),
      created({ sha: "head-2" }),
      created({ sha: "tree-3" }),
      created({ sha: "head-3" }),
      ok({ object: { sha: "head-1" } }),
      ok({}),
      ok({ sha: "head-3", tree: { sha: "tree-3" } }),
      ok({ sha: "tree-3", truncated: false, tree: [] }),
    ]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    const mutations = Array.from({ length: 101 }, (_, index) => ({
      path: `note-${index}.md`,
      kind: "reuse" as const,
      sha: `blob-${index}`,
    }));

    await expect(client.commit("head-1", mutations, "Sync")).resolves.toMatchObject({
      commitSha: "head-3",
    });
    const commitIndexes = transport.requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.url.endsWith("/git/commits") && request.method === "POST")
      .map(({ index }) => index);
    const refUpdateIndex = transport.requests.findIndex((request) => request.method === "PATCH");
    expect(commitIndexes).toHaveLength(2);
    expect(refUpdateIndex).toBeGreaterThan(commitIndexes[1] ?? -1);
  });

  it("rejects a stale expected branch head before uploading blobs", async () => {
    const transport = new RecordingTransport([ok({ object: { sha: "head-new" } })]);
    const client = new GitHubClient({
      owner: "owner",
      repository: "repo",
      branch: "main",
      token: "secret",
      transport,
    });
    await expect(
      client.commit(
        "head-old",
        [{ path: "note.md", kind: "put", bytes: new TextEncoder().encode("hello") }],
        "Sync",
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<GitHubApiError>>({ status: 409 }));
    expect(transport.requests).toHaveLength(1);
  });
});
